/**
 * One turn: read room -> determine speaker -> generate -> sanitize -> sign & post
 * -> persist local memory. And the outer loop: run a turn, sleep a random
 * interval, repeat -- forever, until asked to stop.
 *
 * Crash/restart safety by construction: every turn starts by re-reading the
 * room and re-deriving the next speaker from it (history.ts), never from local
 * state. A crash between "posted" and "persisted local state" loses nothing
 * that matters -- the next run just sees the post that already landed and
 * hands the turn to the other agent, exactly as if it had planned it that way.
 */

import { determineNextSpeaker, mostRecentTurns, readDebateHistory } from "./history.js";
import { generateDebateTurn, type GenerateTurnParams, type GenerateTurnResult } from "./openai.js";
import { buildInput, buildInstructions } from "./prompt.js";
import { sanitizeDebateMessage } from "./sanitize.js";
import { loadState, recordTurn, saveState } from "./state.js";
import type { Runtime } from "./runtime.js";
import type { AgentId, LoadedAgent } from "./types.js";

function logLine(text: string): void {
  console.log(text);
}

function logEvent(tag: string, fields: Record<string, unknown>): void {
  console.log([`[${tag}]`, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join(" "));
}

const URL_RE = /https?:\/\/\S+/g;

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
  generate?: (params: GenerateTurnParams) => Promise<GenerateTurnResult>;
}

export interface TurnResult {
  seq: number;
  speakerId: AgentId;
  speakerName: string;
  usage?: GenerateTurnResult["usage"];
}

function agentFor(runtime: Runtime, id: AgentId): LoadedAgent {
  return id === "A" ? runtime.agentA : runtime.agentB;
}

export async function runOneTurn(runtime: Runtime, deps: TurnDeps = {}): Promise<TurnResult> {
  const { client, definition, config } = runtime;

  const snapshot = await readDebateHistory(client, definition.room, runtime.agentA.did, runtime.agentB.did);
  const speakerId = determineNextSpeaker(snapshot.turns);
  const speaker = agentFor(runtime, speakerId);
  logEvent("turn", { next_speaker: speaker.name });

  const state = loadState(config.statePath, definition.room);
  const recent = mostRecentTurns(snapshot.turns, config.historyMessages);

  const instructions = buildInstructions(speaker, definition, config.maxMessageChars, config.webSearchEnabled);
  const input = buildInput(speaker, recent, state);

  logEvent("openai", { generating: true, web_search: config.webSearchEnabled });
  const generate = deps.generate ?? ((params: GenerateTurnParams) => generateDebateTurn(runtime.openai, config, params));
  const result = await generate({ instructions, input });
  if (result.usage) logEvent("openai", { input: result.usage.inputTokens, output: result.usage.outputTokens });

  const sanitized = sanitizeDebateMessage(result.text, config.maxMessageChars);

  const { posted } = await client.sendSignedMessagePost(definition.room, sanitized, { identity: speaker });
  logEvent("technocore", { posted: `seq=${posted.seq}` });

  const newState = recordTurn(state, {
    seq: posted.seq,
    speakerDid: speaker.did,
    // Cheap, no extra OpenAI call: a short excerpt of what was actually said is
    // a decent "don't repeat this" memory aid on its own. Real topic extraction
    // would need a second model call, which the per-turn cost budget rules out.
    newClaims: [sanitized.length > 200 ? `${sanitized.slice(0, 200)}…` : sanitized],
    newSources: sanitized.match(URL_RE) ?? undefined,
  });
  saveState(config.statePath, newState);

  return { seq: posted.seq, speakerId, speakerName: speaker.name, usage: result.usage };
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
      // failure gets a fresh attempt next cycle instead of hammering it.
      logEvent("error", { message: (err as Error).message ?? String(err) });
    }

    if (options.signal.aborted) break;

    const delaySeconds = randomDelaySeconds(runtime.config.minDelaySeconds, runtime.config.maxDelaySeconds);
    logLine(`[sleep] next message in ${delaySeconds} seconds`);
    await sleep(delaySeconds * 1000, options.signal);
  }
  logLine("[shutdown] stopped");
}
