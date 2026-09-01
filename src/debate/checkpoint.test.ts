import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCheckpoint, isCheckpointDue } from "./checkpoint.js";
import { defaultState, recordTurn } from "./state.js";

test("isCheckpointDue: false when disabled, regardless of count", () => {
  let state = defaultState("d-room");
  state = { ...state, messagesSinceCheckpoint: 999 };
  assert.equal(isCheckpointDue(state, 10, false), false);
});

test("isCheckpointDue: false until the threshold is reached", () => {
  const state = { ...defaultState("d-room"), messagesSinceCheckpoint: 9 };
  assert.equal(isCheckpointDue(state, 10, true), false);
});

test("isCheckpointDue: true once the threshold is reached", () => {
  const state = { ...defaultState("d-room"), messagesSinceCheckpoint: 10 };
  assert.equal(isCheckpointDue(state, 10, true), true);
});

test("isCheckpointDue: CHECKPOINT_EVERY_MESSAGES=0 never triggers (avoids a checkpoint every single turn)", () => {
  const state = { ...defaultState("d-room"), messagesSinceCheckpoint: 5 };
  assert.equal(isCheckpointDue(state, 0, true), false);
});

test("formatCheckpoint: reports real, measured claim counts and includes the open question", () => {
  let state = defaultState("d-room");
  state = recordTurn(state, {
    seq: 1,
    speakerDid: "did:key:z6MkTest",
    newClaimRecords: [
      { author: "A", claim: "Real Madrid has 15 European Cups", status: "verified", verifiedBy: "B", sources: ["https://uefa.com/x"] },
      { author: "B", claim: "Barcelona invented tiki-taka", status: "disputed", verifiedBy: "A", sources: [] },
      { author: "A", claim: "Barcelona have 5 Champions Leagues", status: "corrected", verifiedBy: "B", sources: ["https://uefa.com/y"] },
    ],
  });

  const text = formatCheckpoint(state, 1, "Does peak dominance matter more than long-term consistency?");
  const lines = text.split("\n");

  assert.equal(lines[0], "DEBATE CHECKPOINT #1");
  assert.ok(text.includes("Claims checked: 3"));
  assert.ok(text.includes("Verified: 1"));
  assert.ok(text.includes("Disputed: 1"));
  assert.ok(text.includes("Corrected: 1"));
  assert.ok(text.includes("Recent correction:"));
  assert.ok(text.includes("Barcelona have 5 Champions Leagues"));
  assert.ok(text.includes("Current unresolved question:"));
  assert.ok(text.includes("Does peak dominance matter more than long-term consistency?"));
  assert.ok(text.includes("https://uefa.com/x"));
});

test("formatCheckpoint: no correction section when nothing has been corrected", () => {
  const state = defaultState("d-room");
  const text = formatCheckpoint(state, 1, "An open question.");
  assert.ok(!text.includes("Recent correction:"));
  assert.ok(text.includes("Claims checked: 0"));
});

test("formatCheckpoint: claimStats reflect lifetime totals even after old claims age out of claimRecords", () => {
  let state = defaultState("d-room");
  for (let i = 0; i < 50; i++) {
    state = recordTurn(state, {
      seq: i + 1,
      speakerDid: "did:key:z6MkTest",
      newClaimRecords: [{ author: "A", claim: `claim ${i}`, status: "verified", verifiedBy: "B", sources: [] }],
    });
  }
  assert.ok(state.claimRecords.length < 50); // bounded, some aged out
  const text = formatCheckpoint(state, 5, "q");
  assert.ok(text.includes("Verified: 50")); // lifetime stat, not just the bounded window
});
