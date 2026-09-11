import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWordProposal, runOfficialValidator, type PoemTurnState } from "./validator.js";
import { loadSonnetConfig } from "./config.js";
import type { Lexicon } from "./cmudict.js";
import { readFile } from "node:fs/promises";

const DID_A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const DID_B = "did:key:z6MkereFQqHaUdcF7yVmHvY1rHpAvVjeCggaBVy45hmE8G6C";
const LEXICON: Lexicon = new Map([
  ["the", 1],
  ["deeded", 2],
  ["wool", 1],
]);

const ROSTER = [DID_A, DID_B];
const OPENING = "2026-09-11T12:00:00Z";
const DEADLINE = "2026-09-18T12:00:00Z";
const NOW = new Date("2026-09-12T00:00:00Z");

function freshState(overrides: Partial<PoemTurnState> = {}): PoemTurnState {
  return { version: 5, previousStateHash: "abc", currentLineSyllables: 0, previousContributorDid: DID_B, ...overrides };
}

test("validateWordProposal: accepts a legal word from the allowed contributor", () => {
  const result = validateWordProposal({
    word: "The",
    contributorDid: DID_A,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState(),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, true);
  assert.equal(result.syllables, 1);
  assert.deepEqual(result.errors, []);
});

test("validateWordProposal: fail-closed -- refuses when roster is not locked", () => {
  const result = validateWordProposal({
    word: "The",
    contributorDid: DID_A,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: false,
    poemState: freshState(),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("not locked")));
});

test("validateWordProposal: the previous contributor cannot act", () => {
  const result = validateWordProposal({
    word: "The",
    contributorDid: DID_B,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState({ previousContributorDid: DID_B }),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("previous accepted contributor")));
});

test("validateWordProposal: a different allowed contributor can act", () => {
  const result = validateWordProposal({
    word: "The",
    contributorDid: DID_A,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState({ previousContributorDid: DID_B }),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, true);
});

test("validateWordProposal: refuses a non-roster contributor", () => {
  const outsider = "did:key:z6MktSMm5HJuoDCzZNJ5YVKPjHrTw86iEn3YwXKNExe9UsZn";
  const result = validateWordProposal({
    word: "The",
    contributorDid: outsider,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState(),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("not a member")));
});

test("validateWordProposal: rejects a word whose letters aren't all in the DID", () => {
  const result = validateWordProposal({
    word: "wool",
    contributorDid: DID_A,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState(),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("letters absent")));
});

test("validateWordProposal: rejects a word that would overflow the 10-syllable line", () => {
  const result = validateWordProposal({
    word: "deeded",
    contributorDid: DID_A,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState({ currentLineSyllables: 9 }),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("overflow")));
});

test("validateWordProposal: rejects a stale version/previous_state_hash", () => {
  const result = validateWordProposal({
    word: "The",
    contributorDid: DID_A,
    lexicon: LEXICON,
    rosterMembers: ROSTER,
    rosterLocked: true,
    poemState: freshState({ version: 6, previousStateHash: "new-hash" }),
    contestOpeningUtc: OPENING,
    contestDeadlineUtc: DEADLINE,
    expectedVersion: 5,
    expectedPreviousStateHash: "abc",
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("stale version")));
  assert.ok(result.errors.some((e) => e.includes("stale previous_state_hash")));
});

test("validateWordProposal: rejects an action before contest opening or after its deadline", () => {
  const before = validateWordProposal({
    word: "The", contributorDid: DID_A, lexicon: LEXICON, rosterMembers: ROSTER, rosterLocked: true,
    poemState: freshState(), contestOpeningUtc: OPENING, contestDeadlineUtc: DEADLINE, now: new Date("2026-09-10T00:00:00Z"),
  });
  assert.equal(before.valid, false);
  assert.ok(before.errors.some((e) => e.includes("not opened")));

  const after = validateWordProposal({
    word: "The", contributorDid: DID_A, lexicon: LEXICON, rosterMembers: ROSTER, rosterLocked: true,
    poemState: freshState(), contestOpeningUtc: OPENING, contestDeadlineUtc: DEADLINE, now: new Date("2026-09-19T00:00:00Z"),
  });
  assert.equal(after.valid, false);
  assert.ok(after.errors.some((e) => e.includes("deadline")));
});

test("runOfficialValidator: the vendored example poem passes form_valid", async () => {
  const config = loadSonnetConfig({});
  const poemText = (await readFile("vendor/technocore-sonnet/examples/format-poem.txt", "utf8")).replace(/\n$/, "");
  const result = await runOfficialValidator(config, poemText);
  assert.equal(result.ok, true);
  assert.equal(result.output?.form_valid, true);
  assert.deepEqual(result.output?.syllables_per_line, new Array(14).fill(10));
});

test("runOfficialValidator: a malformed poem is reported as ok:false with the script's own reason", async () => {
  const config = loadSonnetConfig({});
  const result = await runOfficialValidator(config, "only one line");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /lines: expected 14/);
});
