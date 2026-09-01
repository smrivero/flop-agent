import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUtcDay, defaultState, loadState, recordTurn, rolloverDayIfNeeded, saveState, touchMaintenance } from "./state.js";

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

// -- daily message counter -------------------------------------------------

test("state: defaultState starts at 0 messages today, on today's UTC date", () => {
  const state = defaultState("d-testroom");
  assert.equal(state.messagesToday, 0);
  assert.equal(state.currentDay, currentUtcDay());
});

test("state: recordTurn increments messagesToday alongside totalMessages", () => {
  let state = defaultState("d-testroom");
  state = recordTurn(state, { seq: 1, speakerDid: "did:key:z6MkTest" });
  state = recordTurn(state, { seq: 2, speakerDid: "did:key:z6MkTest" });
  assert.equal(state.messagesToday, 2);
  assert.equal(state.totalMessages, 2);
});

test("rolloverDayIfNeeded: same day -- state unchanged", () => {
  const state = { ...defaultState("d-testroom"), messagesToday: 3 };
  const rolled = rolloverDayIfNeeded(state, new Date());
  assert.equal(rolled.messagesToday, 3);
  assert.equal(rolled, state); // same reference -- no unnecessary copy
});

test("rolloverDayIfNeeded: a new UTC day resets messagesToday to 0", () => {
  const state = { ...defaultState("d-testroom"), messagesToday: 4, currentDay: "2026-08-30" };
  const rolled = rolloverDayIfNeeded(state, new Date("2026-09-01T00:00:01Z"));
  assert.equal(rolled.messagesToday, 0);
  assert.equal(rolled.currentDay, "2026-09-01");
});

test("recordTurn: a turn on a new UTC day rolls the counter over before incrementing (never carries yesterday's count)", () => {
  const yesterday = { ...defaultState("d-testroom"), messagesToday: 4, currentDay: "2026-08-30" };
  const state = recordTurn(yesterday, { seq: 1, speakerDid: "did:key:z6MkTest", now: new Date("2026-09-01T00:00:01Z") });
  assert.equal(state.messagesToday, 1); // rolled to 0, then incremented -- not 5
  assert.equal(state.currentDay, "2026-09-01");
});

// -- structured claim history / stats --------------------------------------

test("state: claimRecords get sequential ids and claimStats accumulate by status", () => {
  let state = defaultState("d-testroom");
  state = recordTurn(state, {
    seq: 1,
    speakerDid: "did:key:z6MkTest",
    newClaimRecords: [
      { author: "A", claim: "Madrid has 15 CLs", status: "verified", verifiedBy: "B", sources: ["https://uefa.com"] },
      { author: "B", claim: "Barca invented tiki-taka", status: "unverified", sources: [] },
    ],
  });
  assert.equal(state.claimRecords[0].id, "claim-0001"); // Madrid claim, listed first in this turn's additions
  assert.equal(state.claimRecords[1].id, "claim-0002"); // Barca claim, second
  assert.equal(state.claimCounter, 2);
  assert.equal(state.claimStats.verified, 1);
  assert.equal(state.claimStats.disputed, 0); // "unverified" claims aren't tracked in claimStats -- not a terminal check
});

test("state: claimStats keep accumulating even once old claimRecords age out of the bounded list", () => {
  let state = defaultState("d-testroom");
  for (let i = 0; i < 50; i++) {
    state = recordTurn(state, {
      seq: i + 1,
      speakerDid: "did:key:z6MkTest",
      newClaimRecords: [{ author: "A", claim: `claim ${i}`, status: "disputed", verifiedBy: "B", sources: [] }],
    });
  }
  assert.ok(state.claimRecords.length < 50); // bounded
  assert.equal(state.claimStats.disputed, 50); // lifetime total, unbounded
  assert.equal(state.claimCounter, 50); // ids never reused
});

test("state: claim ids never collide even after entries age out (counter never resets)", () => {
  let state = defaultState("d-testroom");
  for (let i = 0; i < 45; i++) {
    state = recordTurn(state, {
      seq: i + 1,
      speakerDid: "did:key:z6MkTest",
      newClaimRecords: [{ author: "A", claim: `claim ${i}`, status: "verified", verifiedBy: "B", sources: [] }],
    });
  }
  const ids = state.claimRecords.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length); // all unique
});

// -- checkpoint countdown ----------------------------------------------------

test("state: messagesSinceCheckpoint increments on a normal turn, resets on a checkpoint turn", () => {
  let state = defaultState("d-testroom");
  state = recordTurn(state, { seq: 1, speakerDid: "did:key:z6MkTest" });
  state = recordTurn(state, { seq: 2, speakerDid: "did:key:z6MkTest" });
  assert.equal(state.messagesSinceCheckpoint, 2);

  state = recordTurn(state, { seq: 3, speakerDid: "did:key:z6MkTest", isCheckpoint: true });
  assert.equal(state.messagesSinceCheckpoint, 0);
  assert.equal(state.checkpointCount, 1);
});

// -- maintenance timestamps ---------------------------------------------------

test("touchMaintenance: patches only the given maintenance fields, leaves the rest untouched", () => {
  let state = defaultState("d-testroom");
  state = recordTurn(state, { seq: 5, speakerDid: "did:key:z6MkTest" });
  const patched = touchMaintenance(state, { lastArchiveAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(patched.lastArchiveAt, "2026-09-01T00:00:00.000Z");
  assert.equal(patched.lastIdentityRefreshA, null);
  assert.equal(patched.totalMessages, 1); // untouched by touchMaintenance
  assert.equal(patched.lastProcessedSeq, 5); // untouched by touchMaintenance
});
