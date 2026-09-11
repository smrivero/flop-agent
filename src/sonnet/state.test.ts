import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultState, loadState, saveState, transition, InvalidTransitionError } from "./state.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sonnet-state-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("state persistence: save then load round-trips exactly (restart resumes last seq)", () => {
  withTmpDir((dir) => {
    const path = join(dir, "state.json");
    let state = defaultState("sonnet-1", DID);
    state.discovery = {
      lastScanAtUtc: "2026-09-11T12:00:00.000Z",
      lastProcessedSeq: { "mb-sonnet-1-registration": 42 },
      registeredWriterDids: [DID],
      registeredVoterDids: [],
      registeredOrganizerDids: [],
      pendingTeamRequests: [],
    };
    saveState(path, state);

    const reloaded = loadState(path, "sonnet-1", DID);
    assert.equal(reloaded.discovery?.lastProcessedSeq["mb-sonnet-1-registration"], 42);
    assert.deepEqual(reloaded.discovery?.registeredWriterDids, [DID]);
  });
});

test("state persistence: a corrupt state.json falls back to a fresh default state instead of crashing", () => {
  withTmpDir((dir) => {
    const path = join(dir, "state.json");
    writeFileSync(path, "{not json");
    const state = loadState(path, "sonnet-1", DID);
    assert.equal(state.phase, "UNREGISTERED");
  });
});

test("state persistence: a state.json for a different contest_id/DID is ignored, not merged", () => {
  withTmpDir((dir) => {
    const path = join(dir, "state.json");
    saveState(path, defaultState("sonnet-1", DID));
    const state = loadState(path, "sonnet-2", DID);
    assert.equal(state.contestId, "sonnet-2");
    assert.equal(state.phase, "UNREGISTERED");
  });
});

test("transition: allows only the documented forward transitions", () => {
  let state = defaultState("sonnet-1", DID);
  state = transition(state, "REGISTERED");
  assert.equal(state.phase, "REGISTERED");
  state = transition(state, "DISCOVERING");
  assert.equal(state.phase, "DISCOVERING");
});

test("transition: refuses an invalid/inconsistent transition", () => {
  const state = defaultState("sonnet-1", DID);
  assert.throws(() => transition(state, "WRITING"), InvalidTransitionError);
  assert.throws(() => transition(state, "ROSTER_LOCKED"), InvalidTransitionError);
});
