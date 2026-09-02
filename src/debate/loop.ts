/**
 * One turn: read room -> determine speaker -> check the daily budget -> either
 * publish a checkpoint or generate -> validate (quality gate) -> sign & post
 * -> persist local memory. And the outer loop: run a turn, do best-effort
 * maintenance (archive / identity notes), sleep a random interval, repeat --
 * forever, until asked to stop.
 *
 * Crash/restart safety by construction: every turn starts by re-reading the
 * room and re-deriving the next speaker from it (history.ts), never from local
 * state. A crash between "posted" and "persisted local state" loses nothing
 * that matters -- the next run just sees the post that already landed and
 * hands the turn to the other agent, exactly as if it had planned it that way.
 */

import { archiveRoom, isArchiveDue } from "./archive.js";
import { buildClaimRecords, splitModelOutput, type RawClaim } from "./claims.js";
import { canPublishToday } from "./dailyLimit.js";
import { formatCheckpoint, isCheckpointDue } from "./checkpoint.js";
import { determineNextSpeaker, mostRecentTurns, readDebateHistory } from "./history.js";
import { isIdentityRefreshDue, refreshIdentityNote } from "./identityMaintenance.js";
import type { GenerateTurnInput, GenerateTurnOutput } from "./inference.js";
import { buildInput, buildInstructions } from "./prompt.js";
import { checkRepetition } from "./repetition.js";
import { checkShape } from "./quality.js";
import { randomResponseMode } from "./responseMode.js";
import { isSkip } from "./skip.js";
import { sanitizeDebateMessage } from "./sanitize.js";
import { loadState, recordTurn, saveState, touchMaintenance } from "./state.js";
import type { Runtime } from "./runtime.js";
import type { AgentId, LoadedAgent } from "./types.js";

function logLine(text: string): void {
  console.log(text);
}

function logEvent(tag: string, fields: Record<string, unknown>): void {
  console.log([`[${tag}]`, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(" "));
}

function agentLabel(id: AgentId): string {
  return `agent-${id.toLowerCase()}`;
}

export function randomDelaySeconds(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

export interface TurnDeps {
  /** Injectable for tests -- never calls real OpenAI/Technocore when overridden. */
  generate?: (params: GenerateTurnInput) => Promise<GenerateTurnOutput>;
}

export type TurnOutcome = "published" | "checkpoint" | "skipped" | "daily-limit";

export interface TurnResult {
  outcome: TurnOutcome;
  speakerId: AgentId;
  speakerName: string;
  seq?: number;
  usage?: GenerateTurnOutput["usage"];
}

function agentFor(runtime: Runtime, id: AgentId): LoadedAgent {
  return id === "A" ? runtime.agentA : runtime.agentB;
}

function opponentOf(id: AgentId): AgentId {
  return id === "A" ? "B" : "A";
}

function regenerateInstructionFor(shapeReasons: string[], tooSimilar: boolean): string {
  const notes: string[] = [];
  if (tooSimilar) {
    notes.push("Your previous draft was too similar to earlier messages. Use a different argument, opening, sentence structure and ending. Prefer new evidence.");
  }
  if (shapeReasons.some((r) => r.startsWith("malformed_url"))) {
    notes.push("Your previous draft contained a broken or incomplete URL. Omit links unless you can give a complete, valid one.");
  }
  if (shapeReasons.includes("empty")) {
    notes.push("Your previous draft had no visible content. Write an actual message, or return exactly SKIP if you truly have nothing to add.");
  }
  return "\n\n" + notes.join(" ");
}

function logSearchOutcome(result: GenerateTurnOutput): void {
  if (result.usage) logEvent("openai", { input: result.usage.inputTokens, output: result.usage.outputTokens });
  if (result.webSearch.called) {
    logLine("[research] web_search executed");
    logLine(`[openai] queries=${result.webSearch.queries.length}`);
    if (result.webSearch.sources.length > 0) {
      logLine(`[sources] ${result.webSearch.sources.length} sources`);
    }
  } else {
    logLine("[research] no meaningful new information");
  }
}

interface Candidate {
  raw: GenerateTurnOutput;
  message: string;
  claims: RawClaim[];
}

/** Runs up to two generation attempts (one regeneration, per the quality
 * gate's "regenerate once" rule), returning either a validated candidate
 * ready to publish, or `null` if the turn should be skipped -- either because
 * the model itself returned SKIP, or because neither attempt passed the local
 * quality checks (empty, malformed URL, or too similar to recent messages). */
async function generateValidatedCandidate(
  generate: (params: GenerateTurnInput) => Promise<GenerateTurnOutput>,
  instructions: string,
  baseInput: string,
  ownRecentMessages: string[],
  repetitionThreshold: number,
  maxMessageChars: number,
  allowSkipTurn: boolean,
): Promise<{ candidate: Candidate } | { skip: true; reason: string }> {
  let input = baseInput;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await generate({ instructions, input });
    logSearchOutcome(raw);
    const split = splitModelOutput(raw.text);

    if (isSkip(split.message)) {
      if (allowSkipTurn) return { skip: true, reason: "model returned SKIP" };
      // Skipping is disabled -- never publish the literal word "SKIP" as a
      // message; treat it as a no-op this cycle instead of forcing a reply.
      return { skip: true, reason: "model returned SKIP but ALLOW_SKIP_TURN=false" };
    }

    const sanitized = sanitizeDebateMessage(split.message, maxMessageChars);
    const shape = checkShape(sanitized);
    const repetition = checkRepetition(sanitized, ownRecentMessages, repetitionThreshold);

    // TEMP DEBUG -- remove after diagnosing the persistent repetition=1.00.
    console.log("=== DEBUG sanitized candidate ===\n" + sanitized);
    console.log("=== DEBUG ownRecentMessages.length ===", ownRecentMessages.length);
    if (repetition.matchedIndex !== undefined) {
      console.log("=== DEBUG matched recent message [" + repetition.matchedIndex + "] ===\n" + ownRecentMessages[repetition.matchedIndex]);
    }

    logEvent("quality", { repetition: repetition.maxScore.toFixed(2) });
    for (const reason of shape.reasons) logEvent("quality", { issue: reason });

    if (shape.ok && !repetition.tooSimilar) {
      return { candidate: { raw, message: sanitized, claims: split.claims } };
    }

    if (attempt === 1) {
      logLine("[quality] regenerating once");
      input = baseInput + regenerateInstructionFor(shape.reasons, repetition.tooSimilar);
      continue;
    }

    // Second attempt still failed -- no further retries (no infinite loops).
    return { skip: true, reason: repetition.tooSimilar ? "repetitive response" : `quality gate: ${shape.reasons.join(",")}` };
  }

  // Unreachable (the loop always returns), but keeps the function total for TS.
  return { skip: true, reason: "unreachable" };
}

export async function runOneTurn(runtime: Runtime, deps: TurnDeps = {}): Promise<TurnResult> {
  const { client, definition, config } = runtime;

  const snapshot = await readDebateHistory(client, definition.room, runtime.agentA.did, runtime.agentB.did);
  const speakerId = determineNextSpeaker(snapshot.turns);
  const speaker = agentFor(runtime, speakerId);
  logEvent("turn", { next: agentLabel(speakerId) });

  const state = loadState(config.statePath, definition.room);

  if (!canPublishToday(state, config.maxMessagesPerDay)) {
    logLine(`[daily] ${state.messagesToday}/${config.maxMessagesPerDay} messages -- limit reached, waiting for the next UTC day`);
    return { outcome: "daily-limit", speakerId, speakerName: speaker.name };
  }

  const recent = mostRecentTurns(snapshot.turns, config.historyMessages);
  const ownRecentMessages = snapshot.turns
    .filter((t) => t.agentId === speakerId)
    .slice(-config.recentMessagesForSimilarity)
    .map((t) => t.text);

  const generate = deps.generate ?? ((params: GenerateTurnInput) => runtime.inferenceProvider.generateTurn(params));

  // Checkpoint: replaces a normal reply entirely, formatted locally from
  // claim state -- no OpenAI call, so it never competes with the quality gate
  // or repetition check either.
  if (isCheckpointDue(state, config.checkpointEveryMessages, config.checkpointEnabled)) {
    const checkpointText = sanitizeDebateMessage(
      formatCheckpoint(state, state.checkpointCount + 1, definition.topic),
      config.maxMessageChars,
    );
    const { posted } = await client.sendSignedMessagePost(definition.room, checkpointText, { identity: speaker });
    logLine(`[technocore] published seq=${posted.seq}`);
    logLine(`[daily] ${state.messagesToday + 1}/${config.maxMessagesPerDay} messages`);

    const newState = recordTurn(state, {
      seq: posted.seq,
      speakerDid: speaker.did,
      isCheckpoint: true,
    });
    saveState(config.statePath, newState);
    return { outcome: "checkpoint", speakerId, speakerName: speaker.name, seq: posted.seq };
  }

  const mode = randomResponseMode();
  logLine(`[mode] ${mode}`);

  const instructions = buildInstructions(speaker, definition, config.webSearchEnabled);
  const baseInput = buildInput(speaker, recent, state, mode, config.maxMessageChars);

  const outcome = await generateValidatedCandidate(
    generate,
    instructions,
    baseInput,
    ownRecentMessages,
    config.repetitionThreshold,
    config.maxMessageChars,
    config.allowSkipTurn,
  );

  if ("skip" in outcome) {
    const reason = outcome.reason === "model returned SKIP" ? "no useful contribution" : outcome.reason;
    logLine(`[turn] ${agentLabel(speakerId)} skipped: ${reason}`);
    return { outcome: "skipped", speakerId, speakerName: speaker.name };
  }

  const { candidate } = outcome;
  logLine(`[response] ${candidate.message.length} chars`);

  const { posted } = await client.sendSignedMessagePost(definition.room, candidate.message, { identity: speaker });
  logLine(`[technocore] published seq=${posted.seq}`);

  const claimRecords = buildClaimRecords(candidate.claims, speakerId, opponentOf(speakerId));
  logLine(
    `[claims] detected=${candidate.claims.length} verified=${claimRecords.filter((c) => c.status === "verified").length} disputed=${claimRecords.filter((c) => c.status === "disputed").length}`,
  );

  const newState = recordTurn(state, {
    seq: posted.seq,
    speakerDid: speaker.did,
    // Cheap, no extra OpenAI call: a short excerpt of what was actually said is
    // a decent "don't repeat this" memory aid on its own.
    newClaims: [candidate.message.length > 200 ? `${candidate.message.slice(0, 200)}…` : candidate.message],
    newSources: candidate.raw.webSearch.sources.length > 0 ? candidate.raw.webSearch.sources : undefined,
    newClaimRecords: claimRecords,
  });
  saveState(config.statePath, newState);
  logLine(`[daily] ${newState.messagesToday}/${config.maxMessagesPerDay} messages`);

  return { outcome: "published", speakerId, speakerName: speaker.name, seq: posted.seq, usage: candidate.raw.usage };
}

/**
 * Archive and identity-note refresh, checked once per loop iteration and
 * fully independent of whether a turn published anything -- see archive.ts /
 * identityMaintenance.ts for why each exists. Every failure here is caught
 * and logged, never propagated: this must never affect the debate loop.
 */
export async function runMaintenance(runtime: Runtime): Promise<void> {
  const { client, definition, config } = runtime;
  const state = loadState(config.statePath, definition.room);
  const patch: Parameters<typeof touchMaintenance>[1] = {};

  if (config.archiveEnabled && isArchiveDue(state.lastArchiveAt, config.archiveIntervalHours)) {
    try {
      const result = await archiveRoom(client, config.archivePath, definition.room);
      logEvent("archive", { path: result.path, bytes: result.bytes, sha256: result.sha256.slice(0, 12) });
      patch.lastArchiveAt = new Date().toISOString();
    } catch (err) {
      logEvent("archive", { error: (err as Error).message ?? String(err) });
    }
  }

  if (config.identityMaintenanceEnabled) {
    if (isIdentityRefreshDue(state.lastIdentityRefreshA, config.identityRefreshHours)) {
      try {
        await refreshIdentityNote(client, runtime.agentA);
        logEvent("identity", { agent: "agent-a", refreshed: true });
        patch.lastIdentityRefreshA = new Date().toISOString();
      } catch (err) {
        logEvent("identity", { agent: "agent-a", error: (err as Error).message ?? String(err) });
      }
    }
    if (isIdentityRefreshDue(state.lastIdentityRefreshB, config.identityRefreshHours)) {
      try {
        await refreshIdentityNote(client, runtime.agentB);
        logEvent("identity", { agent: "agent-b", refreshed: true });
        patch.lastIdentityRefreshB = new Date().toISOString();
      } catch (err) {
        logEvent("identity", { agent: "agent-b", error: (err as Error).message ?? String(err) });
      }
    }
  }

  if (Object.keys(patch).length > 0) {
    saveState(config.statePath, touchMaintenance(loadState(config.statePath, definition.room), patch));
  }
}

export interface LoopOptions {
  /** Resolves (or is already aborted) to stop the loop between turns/sleeps. */
  signal: AbortSignal;
}

export async function runDebateLoop(runtime: Runtime, options: LoopOptions, deps: TurnDeps = {}): Promise<void> {
  while (!options.signal.aborted) {
    try {
      await runOneTurn(runtime, deps);
    } catch (err) {
      // Log and move on -- turn order is never modified on failure (it's
      // re-derived from the room on the next iteration regardless), and this
      // is deliberately not retried immediately: a 422 duplicate-text refusal
      // would just refuse the identical text again, and a transient network/API
      // failure gets a fresh attempt next cycle instead of hammering it. This is
      // also where a WebSearchNotPerformedError lands when WEB_SEARCH_REQUIRED
      // rejects an unverified turn -- retried next cycle, never published.
      logEvent("error", { message: (err as Error).message ?? String(err) });
    }

    if (options.signal.aborted) break;

    try {
      await runMaintenance(runtime);
    } catch (err) {
      logEvent("error", { source: "maintenance", message: (err as Error).message ?? String(err) });
    }

    if (options.signal.aborted) break;

    const delaySeconds = randomDelaySeconds(runtime.config.minDelaySeconds, runtime.config.maxDelaySeconds);
    logLine(`[sleep] next check in ${delaySeconds} seconds`);
    await sleep(delaySeconds * 1000, options.signal);
  }
  logLine("[shutdown] stopped");
}
