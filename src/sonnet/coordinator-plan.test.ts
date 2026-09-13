import { test } from "node:test";
import assert from "node:assert/strict";
import { findLatestCoordinatorPlan } from "./coordinator-plan.js";
import type { Message } from "../technocore.js";

function note(seq: number, text: unknown): Message {
  return { seq, ts: "2026-09-13T13:00:00Z", from: "did:key:z6Mktest", text: typeof text === "string" ? text : JSON.stringify(text), nonce: seq, sig: "x" };
}

test("findLatestCoordinatorPlan: undefined when no sonnet.note.v1 with a poem field exists", () => {
  const messages = [note(1, { type: "sonnet.note.v1", text: "gl team!" }), note(2, "plain chat, not even JSON")];
  assert.equal(findLatestCoordinatorPlan(messages, 1), undefined);
});

test("findLatestCoordinatorPlan: extracts words from the poem text, stripping punctuation", () => {
  const messages = [note(1, { type: "sonnet.note.v1", room_generation: 1, poem: "We form the names,\nwhere silent ledgers show." })];
  const words = findLatestCoordinatorPlan(messages, 1);
  assert.deepEqual(
    words?.map((w) => w.word),
    ["we", "form", "the", "names", "where", "silent", "ledgers", "show"],
  );
  assert.equal(words?.[0].raw, "We"); // original casing preserved
  assert.equal(words?.[3].raw, "names,"); // raw keeps punctuation; word doesn't
});

test("findLatestCoordinatorPlan: ignores a plan for a DIFFERENT room_generation (stale, from before a reset)", () => {
  const messages = [note(1, { type: "sonnet.note.v1", room_generation: 0, poem: "Old plan words here" })];
  assert.equal(findLatestCoordinatorPlan(messages, 1), undefined);
});

test("findLatestCoordinatorPlan: a plan with no room_generation field applies to any generation", () => {
  const messages = [note(1, { type: "sonnet.note.v1", poem: "Ungated plan words" })];
  const words = findLatestCoordinatorPlan(messages, 5);
  assert.ok(words);
  assert.equal(words[0].word, "ungated");
});

test("findLatestCoordinatorPlan: picks the LATEST plan when several were posted (e.g. a revision)", () => {
  const messages = [
    note(1, { type: "sonnet.note.v1", room_generation: 1, poem: "First draft plan" }),
    note(2, { type: "sonnet.note.v1", room_generation: 1, poem: "Revised better plan" }),
  ];
  const words = findLatestCoordinatorPlan(messages, 1);
  assert.equal(words?.[0].word, "revised");
});

test("findLatestCoordinatorPlan: ignores non-note messages and malformed JSON without crashing", () => {
  const messages = [
    note(1, "not json at all"),
    note(2, { type: "sonnet.word.v1", word: "key" }),
    note(3, { type: "sonnet.note.v1", room_generation: 1, poem: "Real plan text" }),
  ];
  const words = findLatestCoordinatorPlan(messages, 1);
  assert.equal(words?.[0].word, "real");
});
