import { test } from "node:test";
import assert from "node:assert/strict";
import { canPublishToday } from "./dailyLimit.js";
import { defaultState, recordTurn } from "./state.js";

test("canPublishToday: true when under the limit", () => {
  const state = defaultState("d-room");
  assert.equal(canPublishToday(state, 4), true);
});

test("canPublishToday: false once messagesToday reaches the max", () => {
  let state = defaultState("d-room");
  for (let i = 0; i < 4; i++) {
    state = recordTurn(state, { seq: i + 1, speakerDid: "did:key:z6MkTest" });
  }
  assert.equal(state.messagesToday, 4);
  assert.equal(canPublishToday(state, 4), false);
});

test("canPublishToday: a new UTC day resets the count even if the persisted state is stale", () => {
  let state = defaultState("d-room");
  for (let i = 0; i < 4; i++) {
    state = recordTurn(state, { seq: i + 1, speakerDid: "did:key:z6MkTest" });
  }
  assert.equal(canPublishToday(state, 4), false);

  const tomorrow = new Date(Date.now() + 25 * 3600_000); // safely past UTC midnight regardless of current time
  assert.equal(canPublishToday(state, 4, tomorrow), true);
});

test("canPublishToday: MAX_MESSAGES_PER_DAY=0 disables publishing entirely for the day", () => {
  const state = defaultState("d-room");
  assert.equal(canPublishToday(state, 0), false);
});
