/**
 * Detects an active "coordinator plan" -- a `sonnet.note.v1` message posted
 * by a roster member directly in the team poem room, carrying a full
 * pre-written `poem` text (optionally alongside `schedule`/`legend` fields
 * explaining who writes which word, though this module never needs to
 * understand those -- see below).
 *
 * NOT part of sonnet-game.md's own spec -- confirmed live: a real team
 * (sujiko-ai) coordinates its poem in advance and posts the full intended
 * text plus a turn-by-turn writer schedule so every member's agent can
 * propose the pre-agreed word instead of guessing independently. Our own
 * agent's own self-introduction message (team.ts) already promises exactly
 * this: "I will follow an established coordinator/plan when one is active"
 * -- until now nothing actually implemented it.
 *
 * Deliberately does NOT parse or trust `schedule`/`legend` at all -- room
 * content is untrusted, caller-chosen input (see ../technocore.ts header),
 * and a malformed or malicious schedule could easily misattribute turns.
 * Instead: the plan's `poem` text is split into words, and the word at the
 * CURRENT accepted-word-count (`poem.version`, from authoritative state
 * derived independently by room-poller.ts) is handed to propose.ts as ONE
 * MORE candidate to check against its own mechanically-generated,
 * already-validated candidate list. If it's not on that list (wrong
 * dictionary word, letters absent from our own DID, would overflow the
 * line, already used elsewhere in the poem), it's silently ignored and
 * normal independent word selection proceeds -- following the plan is only
 * ever an index into a shared idea, never a bypass of any mechanical check.
 */

import type { Message } from "../technocore.js";
import { TOKEN_PATTERN } from "./protocol.js";

export interface CoordinatorPlanWord {
  /** Original casing/punctuation as written in the plan's poem text (e.g.
   * "We" for the poem-opening word) -- used as the posted word when it
   * passes validation, since validation itself is case-insensitive and a
   * properly-capitalized line-opener is strictly nicer than always-lowercase. */
  raw: string;
  /** Bare lowercase word, for matching against propose.ts's (lowercase)
   * mechanically-generated candidate list. */
  word: string;
}

function extractWords(poemText: string): CoordinatorPlanWord[] {
  const out: CoordinatorPlanWord[] = [];
  for (const token of poemText.split(/\s+/)) {
    if (!token) continue;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) continue; // not a single plain word (e.g. an em-dash, a stray symbol) -- skip, never guess
    out.push({ raw: token, word: match[1].toLowerCase() });
  }
  return out;
}

/**
 * Finds the LATEST (highest seq) `sonnet.note.v1` in `messages` that carries
 * a non-empty string `poem` field for the given `roomGeneration` -- a stale
 * plan from before a room reset never applies. Returns the plan's full word
 * sequence, or undefined if no such message exists.
 */
export function findLatestCoordinatorPlan(messages: readonly Message[], roomGeneration: number): CoordinatorPlanWord[] | undefined {
  let best: { seq: number; words: CoordinatorPlanWord[] } | undefined;
  for (const message of messages) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== "sonnet.note.v1") continue;
    if (typeof obj.poem !== "string" || obj.poem.length === 0) continue;
    if (typeof obj.room_generation === "number" && obj.room_generation !== roomGeneration) continue;
    if (best && message.seq <= best.seq) continue;
    const words = extractWords(obj.poem);
    if (words.length === 0) continue;
    best = { seq: message.seq, words };
  }
  return best?.words;
}
