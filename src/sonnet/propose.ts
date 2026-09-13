/**
 * Ties the whole word-proposal pipeline together, exactly the order the
 * operator specified:
 *
 *   AUTHORITATIVE STATE (room-poller.ts)
 *     -> MECHANICAL CONSTRAINTS (candidate-generator.ts)
 *     -> LEGAL CANDIDATES
 *     -> LLM RANKING (poetry-planner.ts, closed-set re-checked there already)
 *     -> LOCAL VALIDATION (validator.ts, re-checked again here against the
 *        state as of right before building the signed request)
 *     -> DRY-RUN / POST
 *
 * Same dry-run/real/confirm discipline as registration.ts/team.ts/roster.ts:
 * a dry run builds and locally verifies the exact signed request without
 * ever sending it; the real path re-polls state once more immediately
 * before posting (to avoid proposing against state that went stale while
 * the LLM call was in flight), then independently reads the room back.
 */

import { TechnocoreClient, buildSignedMessageRequest, verifySignatureLocally } from "../technocore.js";
import { createTechnocoreClient } from "./http-debug.js";
import type { TechnocoreIdentity } from "../identity.js";
import { buildWordPayload, freshRequestId, sonnetRooms, toCanonicalJson } from "./protocol.js";
import { pollTeamRoom, type AuthoritativePoemState } from "./room-poller.js";
import { generateCandidates } from "./candidate-generator.js";
import { planNextWord, targetRhymeWord, type PlannedWord } from "./poetry-planner.js";
import { validateWordProposal } from "./validator.js";
import { checkRoomSetup } from "./team.js";
import type { Lexicon } from "./cmudict.js";
import type { RhymeIndex } from "./rhyme.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { sonnetLog } from "./logger.js";

export class ProposeError extends Error {}

export interface ProposeContext {
  gameId: string;
  rosterMembers: readonly string[];
  lexicon: Lexicon;
  rhymeIndex: RhymeIndex;
  maxCandidatesShown?: number;
}

export interface ProposePreview {
  room: string;
  gameId: string;
  poem: AuthoritativePoemState;
  planned: PlannedWord;
  payload: ReturnType<typeof buildWordPayload>;
  canonicalJson: string;
  did: string;
  signature: string;
  nonce: string;
  verifiedLocally: boolean;
}

/**
 * Runs the full pipeline and returns a locally-verified, unsent preview.
 * Throws ProposeError at whichever gate fails, with a message naming that
 * gate -- never silently falls through to a worse choice.
 */
export async function buildProposePreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  ctx: ProposeContext,
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<ProposePreview> {
  const rooms = sonnetRooms(contest);
  const poemRoom = rooms.team(ctx.gameId);

  // Cheapest, most decisive gate first -- refuse before ever spending an LLM
  // call if there's nowhere to post the result anyway.
  const setup = await checkRoomSetup(contest, config, ctx.gameId, client);
  if (!setup.hasMessages || setup.generation === undefined) {
    throw new ProposeError(`team room ${poemRoom} does not appear to be set up by the referee yet`);
  }

  const poem = await pollTeamRoom(client, poemRoom, ctx.rosterMembers, ctx.lexicon);
  if (poem.complete) throw new ProposeError("poem is already complete (14 lines) -- nothing to propose");
  if (!poem.hashKnown) throw new ProposeError("cannot confidently determine the referee's latest state hash yet -- refusing to propose (see room-poller.ts)");
  if (poem.previousContributorDid === identity.did) {
    throw new ProposeError("we were the previous accepted contributor -- may not propose the next word");
  }
  if (!ctx.rosterMembers.includes(identity.did)) throw new ProposeError("we are not a member of the given roster");

  const remainingSyllables = 10 - poem.lines[poem.currentLineIndex].syllables;
  const target = targetRhymeWord(poem, poem.currentLineIndex);
  const targetRhymeKey = target ? ctx.rhymeIndex.get(target) : undefined;

  const usedWords = new Set(poem.lines.flatMap((line) => line.words.map((w) => w.word.toLowerCase())));
  const candidates = generateCandidates({
    lexicon: ctx.lexicon,
    did: identity.did,
    remainingSyllables,
    rhymeIndex: ctx.rhymeIndex,
    targetRhymeKey,
    limit: ctx.maxCandidatesShown ?? 200,
    excludeWords: usedWords,
  });
  sonnetLog(
    "CANDIDATES",
    `game_id=${ctx.gameId} line=${poem.currentLineIndex + 1} remainingSyllables=${remainingSyllables} legal=${candidates.length}${targetRhymeKey ? ` targetRhyme="${target}"` : ""}`,
  );
  if (candidates.length === 0) throw new ProposeError(`no legal candidates for line ${poem.currentLineIndex + 1} (remaining ${remainingSyllables} syllables)`);

  if (!config.openAiApiKey || !config.openAiModel) {
    throw new ProposeError("OPENAI_API_KEY and OPENAI_MODEL are required for sonnet:propose (reuses this project's existing keys)");
  }
  const planned = await planNextWord(poem, poem.currentLineIndex, candidates, ctx.rhymeIndex, {
    apiKey: config.openAiApiKey,
    model: config.openAiModel,
    timeoutMs: config.httpTimeoutMs,
    maxRetries: config.maxRetries,
  });

  // Final mechanical re-check, against the state as we polled it -- the
  // authoritative gate, independent of poetry-planner.ts's own closed-set check.
  const validation = validateWordProposal({
    word: planned.word,
    contributorDid: identity.did,
    lexicon: ctx.lexicon,
    rosterMembers: ctx.rosterMembers,
    rosterLocked: true,
    poemState: {
      version: poem.version,
      previousStateHash: poem.previousStateHash,
      currentLineSyllables: poem.lines[poem.currentLineIndex].syllables,
      previousContributorDid: poem.previousContributorDid,
    },
    contestOpeningUtc: contest.opening,
    contestDeadlineUtc: contest.deadline,
  });
  sonnetLog("VALIDATE", `word=${JSON.stringify(planned.word)} valid=${validation.valid}${validation.errors.length ? ` errors=[${validation.errors.join("; ")}]` : ""}`);
  if (!validation.valid) throw new ProposeError(`mechanical validation failed: ${validation.errors.join("; ")}`);

  const payload = buildWordPayload({
    contestId: contest.contest_id,
    gameId: ctx.gameId,
    roomGeneration: setup.generation,
    version: poem.version,
    previousStateHash: poem.previousStateHash,
    word: planned.word,
    requestId: freshRequestId("word"),
  });
  const canonicalJson = toCanonicalJson(payload);
  const built = buildSignedMessageRequest(poemRoom, canonicalJson, { identity, baseUrl: config.technocoreBaseUrl });

  return {
    room: poemRoom,
    gameId: ctx.gameId,
    poem,
    planned,
    payload,
    canonicalJson,
    did: built.did,
    signature: built.signature,
    nonce: built.nonce,
    verifiedLocally: verifySignatureLocally(built),
  };
}

export interface ProposeResult {
  preview: ProposePreview;
  sent: boolean;
  postedSeq?: number;
}

export async function proposeWord(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  ctx: ProposeContext,
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<ProposeResult> {
  const preview = await buildProposePreview(identity, contest, config, ctx, client);
  sonnetLog("PROPOSE", `[PREPARE] room=${preview.room} payload=${preview.canonicalJson}`);

  if (config.dryRun) {
    sonnetLog("PROPOSE", "[DRY-RUN] SONNET_DRY_RUN is true -- not publishing.");
    return { preview, sent: false };
  }
  if (!preview.verifiedLocally) throw new ProposeError("local signature verification failed -- refusing to send");

  // Re-poll and re-validate right before POST -- state may have moved on
  // while the LLM call was in flight (sonnet-game.md: "avoid publishing
  // against stale state"). A changed version/hash means someone else's word
  // was accepted first; refuse rather than send a request the referee would
  // reject as stale anyway.
  const fresh = await pollTeamRoom(client, preview.room, ctx.rosterMembers, ctx.lexicon);
  if (fresh.version !== preview.poem.version || fresh.previousStateHash !== preview.poem.previousStateHash) {
    throw new ProposeError(
      `state changed since this proposal was built (version ${preview.poem.version} -> ${fresh.version}) -- refusing to send a stale proposal, rebuild it`,
    );
  }

  sonnetLog("POST", `[SIGNED] did=${preview.did} nonce=${preview.nonce}`);
  const result = await client.sendSignedMessagePost(preview.room, preview.canonicalJson, { identity, baseUrl: config.technocoreBaseUrl });
  sonnetLog("POST", `[SENT] seq=${result.posted.seq}`);

  try {
    const readBack = await client.readRoom(preview.room, { since: Math.max(0, result.posted.seq - 1), limit: 5 });
    const echoed = readBack.messages.find((m) => m.seq === result.posted.seq);
    if (echoed && echoed.from === preview.did && echoed.text === preview.canonicalJson) {
      sonnetLog("RECEIPT", `[CONFIRMED] seq=${echoed.seq} from=${echoed.from}`);
    } else {
      sonnetLog("RECEIPT", `[CONFIRMED] could not verify seq=${result.posted.seq} on read-back`);
    }
  } catch (err) {
    sonnetLog("RECEIPT", `[CONFIRMED] read-back failed (${(err as Error).message})`);
  }

  return { preview, sent: true, postedSeq: result.posted.seq };
}
