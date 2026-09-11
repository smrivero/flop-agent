import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePoemState, TOTAL_LINES } from "./room-poller.js";
import type { Lexicon } from "./cmudict.js";
import type { Message } from "../technocore.js";

const WRITER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_WRITER = "did:key:z6MkereFQqHaUdcF7yVmHvY1rHpAvVjeCggaBVy45hmE8G6C";
const REFEREE = "did:key:z6MktSMm5HJuoDCzZNJ5YVKPjHrTw86iEn3YwXKNExe9UsZn";
const ROSTER = [WRITER, OTHER_WRITER];

// Fake 5-syllable-ish words so two of them close a line quickly in tests.
const LEXICON: Lexicon = new Map([
  ["alpha", 5],
  ["beta", 5],
  ["gamma", 3],
  ["delta", 2],
]);

let seqCounter = 1;
function msg(from: string, text: string): Message {
  return { seq: seqCounter++, ts: new Date().toISOString(), from, text, nonce: seqCounter };
}
function wordProposal(requestId: string, word: string): string {
  return JSON.stringify({ type: "sonnet.word.v1", contest_id: "sonnet-1", game_id: "a", room_generation: 0, version: 0, previous_state_hash: "", word, request_id: requestId });
}
function receipt(requestId: string, hash: string): string {
  return JSON.stringify({ request_id: requestId, state_hash: hash, version: 1 });
}

test("derivePoemState: an empty room yields the initial empty state", () => {
  seqCounter = 1;
  const state = derivePoemState([], ROSTER, LEXICON);
  assert.equal(state.version, 0);
  assert.equal(state.hashKnown, true);
  assert.equal(state.currentLineIndex, 0);
  assert.equal(state.currentLineSyllables, 0);
  assert.equal(state.complete, false);
});

test("derivePoemState: a proposal with no matching referee receipt is NOT counted as accepted", () => {
  seqCounter = 1;
  const messages = [msg(WRITER, wordProposal("r-1", "alpha"))];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.lines[0].words.length, 0);
  assert.equal(state.currentLineSyllables, 0);
});

test("derivePoemState: a receipt referencing a seen request_id accepts the word and tracks syllables/contributor", () => {
  seqCounter = 1;
  const messages = [msg(WRITER, wordProposal("r-1", "alpha")), msg(REFEREE, receipt("r-1", "hash-1"))];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.lines[0].words.length, 1);
  assert.equal(state.lines[0].words[0].word, "alpha");
  assert.equal(state.currentLineSyllables, 5);
  assert.equal(state.previousContributorDid, WRITER);
  assert.equal(state.hashKnown, true);
  assert.equal(state.previousStateHash, "hash-1");
});

test("derivePoemState: two 5-syllable words close a line exactly at 10 and open the next", () => {
  seqCounter = 1;
  const messages = [
    msg(WRITER, wordProposal("r-1", "alpha")),
    msg(REFEREE, receipt("r-1", "hash-1")),
    msg(OTHER_WRITER, wordProposal("r-2", "beta")),
    msg(REFEREE, receipt("r-2", "hash-2")),
  ];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.lines[0].words.length, 2);
  assert.equal(state.lines[0].syllables, 10);
  assert.equal(state.currentLineIndex, 1);
  assert.equal(state.currentLineSyllables, 0);
  assert.equal(state.lines.length, 2);
});

test("derivePoemState: previousContributorDid updates to whoever was JUST accepted (turn-order signal)", () => {
  seqCounter = 1;
  const messages = [
    msg(WRITER, wordProposal("r-1", "delta")),
    msg(REFEREE, receipt("r-1", "hash-1")),
    msg(OTHER_WRITER, wordProposal("r-2", "gamma")),
    msg(REFEREE, receipt("r-2", "hash-2")),
  ];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.previousContributorDid, OTHER_WRITER);
});

test("derivePoemState: a referee message not referencing any known request_id is counted, not guessed at", () => {
  seqCounter = 1;
  const messages = [msg(REFEREE, JSON.stringify({ hello: "world" })), msg(REFEREE, "not even json")];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.unrecognizedRefereeMessages, 2);
  assert.equal(state.lines[0].words.length, 0);
});

test("derivePoemState: a receipt missing any recognizable hash field marks hashKnown false but keeps the word accepted", () => {
  seqCounter = 1;
  const messages = [msg(WRITER, wordProposal("r-1", "alpha")), msg(REFEREE, JSON.stringify({ request_id: "r-1" }))];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.lines[0].words.length, 1);
  assert.equal(state.hashKnown, false);
});

test("derivePoemState: completes after the 14th line closes and ignores anything after", () => {
  seqCounter = 1;
  const messages: Message[] = [];
  for (let line = 0; line < TOTAL_LINES; line++) {
    for (const [i, word] of ["alpha", "beta"].entries()) {
      const requestId = `line${line}-${i}`;
      messages.push(msg(line % 2 === 0 ? WRITER : OTHER_WRITER, wordProposal(requestId, word)));
      messages.push(msg(REFEREE, receipt(requestId, `hash-${requestId}`)));
    }
  }
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.complete, true);
  assert.equal(state.lines.length, TOTAL_LINES);
  assert.equal(state.lines[TOTAL_LINES - 1].syllables, 10);

  // Extra messages past completion are ignored entirely.
  const extra = [...messages, msg(WRITER, wordProposal("extra", "gamma")), msg(REFEREE, receipt("extra", "hash-extra"))];
  const state2 = derivePoemState(extra, ROSTER, LEXICON);
  assert.equal(state2.complete, true);
  assert.equal(state2.lines.length, TOTAL_LINES);
});

test("derivePoemState: an accepted word not in the dictionary is skipped (never crashes)", () => {
  seqCounter = 1;
  const messages = [msg(WRITER, wordProposal("r-1", "notarealword")), msg(REFEREE, receipt("r-1", "hash-1"))];
  const state = derivePoemState(messages, ROSTER, LEXICON);
  assert.equal(state.lines[0].words.length, 0);
});
