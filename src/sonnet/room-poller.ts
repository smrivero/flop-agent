/**
 * Derives authoritative poem state from a team room
 * (`d-sonnet-1-team-<game_id>`). KNOWN LIMITATION, stated up front: the
 * official rules (vendor/technocore-sonnet/sonnet-game.md) give an exact
 * JSON schema for every REQUEST message (`sonnet.word.v1`, `.roster.v1`,
 * etc.) but explicitly do NOT specify the referee's RECEIPT format -- only
 * prose ("Referee receipts provide the next accepted state",
 * "previous_state_hash: hash from latest referee receipt"). This has never
 * been observed against a live team room with real receipts, so the receipt
 * parser below is deliberately defensive: it cross-references `request_id`
 * against proposals we actually saw (which IS fully specified) to decide
 * WHAT was accepted, independent of guessing field names right, and marks
 * state `hashKnown: false` whenever it cannot confidently identify the hash
 * to quote next -- callers (validator.ts's stale-hash check) must treat
 * that as "do not propose yet" rather than guessing. Revisit the hash-field
 * guessing the moment a real team room with real receipts exists.
 *
 * Everything else here is mechanical, not guessed: "Only the admitted
 * writers and referee may post to the team room" means any sender NOT in
 * the roster is, by elimination, the referee (no separate lookup needed);
 * and "Lines close automatically at 10 syllables" is computed directly from
 * the frozen dictionary (cmudict.ts), never read off a receipt field.
 */

import { TechnocoreClient, type Message } from "../technocore.js";
import { tryParseSonnetMessage } from "./protocol.js";
import { readFullRoom } from "./room-export.js";
import { wordSyllables } from "./did-words.js";
import type { Lexicon } from "./cmudict.js";
import { sonnetLog } from "./logger.js";

export interface PoemLine {
  words: Array<{ word: string; contributorDid: string; seq: number; requestId: string }>;
  syllables: number;
}

export interface AuthoritativePoemState {
  version: number;
  previousStateHash: string;
  /** false when a receipt's hash field couldn't be confidently identified --
   * the LAST successfully-identified hash is kept in `previousStateHash`
   * regardless, but callers must not propose against it while this is false. */
  hashKnown: boolean;
  lines: PoemLine[];
  currentLineIndex: number;
  currentLineSyllables: number;
  previousContributorDid?: string;
  complete: boolean;
  lastProcessedSeq: number;
  unrecognizedRefereeMessages: number;
}

export const TOTAL_LINES = 14; // 4/4/4/2 stanzas

function emptyState(): AuthoritativePoemState {
  return {
    version: 0,
    previousStateHash: "",
    hashKnown: true, // the initial state's hash is the well-known empty string -- nothing to guess yet
    lines: [{ words: [], syllables: 0 }],
    currentLineIndex: 0,
    currentLineSyllables: 0,
    complete: false,
    lastProcessedSeq: 0,
    unrecognizedRefereeMessages: 0,
  };
}

/** First string field found under any of `keys` in a parsed JSON object. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

interface PendingProposal {
  requestId: string;
  word: string;
  contributorDid: string;
  seq: number;
}

/**
 * Folds a team room's full history into authoritative poem state. Pure
 * function over already-fetched messages so it's independently testable
 * against fixtures without a live room. `lexicon` is required to compute
 * each accepted word's syllable count (for mechanical line-closing) --
 * an accepted word not found in the dictionary is logged and skipped
 * rather than silently miscounted (should never happen for a genuinely
 * accepted word, since the referee itself enforces dictionary membership).
 */
export function derivePoemState(messages: readonly Message[], rosterMembers: readonly string[], lexicon: Lexicon): AuthoritativePoemState {
  let state = emptyState();
  const rosterSet = new Set(rosterMembers);
  const pendingByRequestId = new Map<string, PendingProposal>();

  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  for (const message of sorted) {
    state = { ...state, lastProcessedSeq: message.seq };
    if (state.complete) continue; // nothing more can be accepted past line 14

    const isFromReferee = !rosterSet.has(message.from);

    if (!isFromReferee) {
      // A roster member's post -- the only structured type they're allowed
      // to send here is sonnet.word.v1; anything else is planning chat and ignored.
      const parsed = tryParseSonnetMessage(message.text);
      if (parsed?.type !== "sonnet.word.v1") continue;
      const record = parsed as unknown as { word?: unknown };
      if (typeof record.word !== "string") continue;
      pendingByRequestId.set(parsed.request_id, { requestId: parsed.request_id, word: record.word, contributorDid: message.from, seq: message.seq });
      continue;
    }

    // A referee message -- try to recognize it as an acceptance receipt.
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.text);
    } catch {
      state = { ...state, unrecognizedRefereeMessages: state.unrecognizedRefereeMessages + 1 };
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      state = { ...state, unrecognizedRefereeMessages: state.unrecognizedRefereeMessages + 1 };
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const referencedRequestId = pickString(obj, ["request_id", "requestId", "accepted_request_id", "ref_request_id"]);
    const proposal = referencedRequestId ? pendingByRequestId.get(referencedRequestId) : undefined;

    if (!proposal) {
      // Could be a setup/roster-ready receipt, a rejection, or a format we
      // don't recognize -- never guessed at, just counted for visibility.
      state = { ...state, unrecognizedRefereeMessages: state.unrecognizedRefereeMessages + 1 };
      continue;
    }
    pendingByRequestId.delete(referencedRequestId!);

    let syllables: number;
    try {
      syllables = wordSyllables(proposal.word, lexicon);
    } catch {
      sonnetLog("STATE", `referee accepted word=${JSON.stringify(proposal.word)} (request_id=${proposal.requestId}) not found in the frozen dictionary -- skipping, cannot count its syllables`);
      continue;
    }

    const newHash = pickString(obj, ["state_hash", "hash", "new_state_hash", "next_state_hash", "previous_state_hash"]);
    const version = pickNumber(obj, ["version", "new_version", "state_version"]) ?? state.version + 1;

    const lines = state.lines.map((l) => ({ ...l, words: [...l.words] }));
    const currentLine = lines[state.currentLineIndex];
    currentLine.words.push({ word: proposal.word, contributorDid: proposal.contributorDid, seq: message.seq, requestId: proposal.requestId });
    currentLine.syllables += syllables;

    const lineClosed = currentLine.syllables >= 10; // "exactly 10" is the referee's own enforced invariant; >= is defensive
    const isLastLine = state.currentLineIndex === TOTAL_LINES - 1;
    let nextLineIndex = state.currentLineIndex;
    let complete: boolean = state.complete;
    if (lineClosed) {
      if (isLastLine) {
        complete = true;
      } else {
        nextLineIndex = state.currentLineIndex + 1;
        lines.push({ words: [], syllables: 0 });
      }
    }

    state = {
      ...state,
      version,
      previousStateHash: newHash ?? state.previousStateHash,
      hashKnown: newHash !== undefined,
      lines,
      currentLineIndex: nextLineIndex,
      currentLineSyllables: lineClosed ? 0 : currentLine.syllables,
      previousContributorDid: proposal.contributorDid,
      complete,
    };
  }

  return state;
}

export async function pollTeamRoom(
  client: TechnocoreClient,
  room: string,
  rosterMembers: readonly string[],
  lexicon: Lexicon,
): Promise<AuthoritativePoemState> {
  const { messages, malformedLines } = await readFullRoom(client, room);
  if (malformedLines > 0) sonnetLog("STATE", `${room}: ${malformedLines} export line(s) could not be parsed and were skipped`);
  const state = derivePoemState(messages, rosterMembers, lexicon);
  if (!state.hashKnown) {
    sonnetLog("STATE", `${room}: could not confidently identify the referee's latest state hash -- refusing to consider state proposable until this is resolved`);
  }
  if (state.unrecognizedRefereeMessages > 0) {
    sonnetLog("STATE", `${room}: ${state.unrecognizedRefereeMessages} referee message(s) did not match any known receipt shape (see room-poller.ts header)`);
  }
  return state;
}
