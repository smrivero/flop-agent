import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState, loadState, recordTurn, saveState } from "./state.js";

function tmpStatePath(): string {
  return mkdtempSync(join(tmpdir(), "debate-state-test-"));
}

test("state: loading with no file yet returns a fresh default state", () => {
  const state = loadState(tmpStatePath(), "d-testroom");
  assert.equal(state.room, "d-testroom");
  assert.equal(state.totalMessages, 0);
  assert.equal(state.lastSpeakerDid, null);
  assert.deepEqual(state.recentTopics, []);
});

test("state: save then load round-trips", () => {
  const dir = tmpStatePath();
  const state = recordTurn(defaultState("d-testroom"), { seq: 5, speakerDid: "did:key:z6MkTest", newClaims: ["claim one"] });
  saveState(dir, state);
  const loaded = loadState(dir, "d-testroom");
  assert.equal(loaded.lastProcessedSeq, 5);
  assert.equal(loaded.lastSpeakerDid, "did:key:z6MkTest");
  assert.deepEqual(loaded.recentClaims, ["claim one"]);
  assert.equal(loaded.totalMessages, 1);
});

test("state: a corrupt state file falls back to default rather than throwing", () => {
  const dir = tmpStatePath();
  writeFileSync(join(dir, "d-testroom.json"), "not json");
  const loaded = loadState(dir, "d-testroom");
  assert.equal(loaded.totalMessages, 0);
});

test("state: recentClaims/recentTopics/recentSources are bounded and never grow without limit", () => {
  let state = defaultState("d-testroom");
  for (let i = 0; i < 100; i++) {
    state = recordTurn(state, { seq: i, speakerDid: "did:key:z6MkTest", newClaims: [`claim ${i}`], newSources: [`https://example.com/${i}`] });
  }
  assert.ok(state.recentClaims.length <= 20, `expected <=20, got ${state.recentClaims.length}`);
  assert.ok(state.recentSources.length <= 20, `expected <=20, got ${state.recentSources.length}`);
  assert.equal(state.totalMessages, 100); // the counter itself is unbounded (it's just a number)
});

test("state: pushing an already-present item moves it to front instead of duplicating", () => {
  let state = defaultState("d-testroom");
  state = recordTurn(state, { seq: 1, speakerDid: "did:key:z6MkTest", newClaims: ["A"] });
  state = recordTurn(state, { seq: 2, speakerDid: "did:key:z6MkTest", newClaims: ["B"] });
  state = recordTurn(state, { seq: 3, speakerDid: "did:key:z6MkTest", newClaims: ["A"] });
  assert.deepEqual(state.recentClaims, ["A", "B"]);
});
