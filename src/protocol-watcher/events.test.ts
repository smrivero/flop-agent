import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveEvents } from "./events.js";
import { openDatabase, insertEventIfNew, getRecentEvents, upsertSource, insertSnapshot } from "./database.js";
import type { ProtocolChange } from "./types.js";

const CTX = { sourceId: "yellowpaper", changeBatchId: "batch-1", snapshotId: 42 };

function change(overrides: Partial<ProtocolChange>): ProtocolChange {
  return {
    sourceId: "yellowpaper",
    detectedAt: "2026-09-10T00:00:00.000Z",
    category: "other",
    changeType: "modified",
    severity: "info",
    evidence: { url: "https://flop.finance/intro/yellowpaper/" },
    ...overrides,
  };
}

test("events: no changes -> no events", () => {
  assert.deepEqual(deriveEvents([], CTX), []);
});

test("events: any change at all always emits FLOP_DOCUMENT_CHANGED, listed first", () => {
  const events = deriveEvents([change({ category: "other", field: "draft_banner" })], CTX);
  assert.equal(events[0].eventType, "FLOP_DOCUMENT_CHANGED");
});

test("events: three validator changes in one batch still emit FLOP_VALIDATOR_REQUIREMENTS_CHANGED exactly once", () => {
  const changes = [
    change({ category: "validator", field: "validator_min_stake", severity: "action_required" }),
    change({ category: "validator", field: "validator_unbonding_blocks", severity: "action_required" }),
    change({ category: "validator", field: "validator_active_set_cap" }),
  ];
  const events = deriveEvents(changes, CTX);
  const validatorEvents = events.filter((e) => e.eventType === "FLOP_VALIDATOR_REQUIREMENTS_CHANGED");
  assert.equal(validatorEvents.length, 1);
  assert.equal(validatorEvents[0].payload.changeCount, 3);
  assert.equal(validatorEvents[0].severity, "action_required", "picks the max severity across the matching changes");
});

test("events: routes airdrop/agent/implementation/testnet/tclk changes to their own event types", () => {
  const changes = [
    change({ category: "airdrop", field: "genesis_agent_airdrop" }),
    change({ category: "agent", field: "agent_share_ppt", severity: "action_required" }),
    change({ category: "implementation", field: "some-requirement" }),
    change({ category: "testnet", field: "meta_testnet", severity: "action_required" }),
    change({ category: "tclk", field: "rail_status", severity: "action_required" }),
  ];
  const types = deriveEvents(changes, CTX).map((e) => e.eventType);
  assert.ok(types.includes("FLOP_AIRDROP_RULES_CHANGED"));
  assert.ok(types.includes("FLOP_AGENT_SCORING_RATIFIED"));
  assert.ok(types.includes("FLOP_IMPLEMENTATION_STATUS_CHANGED"));
  assert.ok(types.includes("FLOP_TESTNET_DATE_CHANGED"));
  assert.ok(types.includes("FLOP_TCLK_RAIL_AVAILABLE"));
});

test("events: a testnet endpoint field routes to FLOP_TESTNET_ENDPOINT_AVAILABLE, not the date event", () => {
  const events = deriveEvents([change({ category: "testnet", field: "testnet_endpoint_url", severity: "action_required" })], CTX);
  const types = events.map((e) => e.eventType);
  assert.ok(types.includes("FLOP_TESTNET_ENDPOINT_AVAILABLE"));
  assert.ok(!types.includes("FLOP_TESTNET_DATE_CHANGED"));
});

test("events: spend-to-unlock field routes to FLOP_SPEND_TO_UNLOCK_CHANGED", () => {
  const events = deriveEvents([change({ field: "spend_to_unlock_ratio" })], CTX);
  assert.ok(events.some((e) => e.eventType === "FLOP_SPEND_TO_UNLOCK_CHANGED"));
});

test("events + database: emitting the same batch twice is idempotent (never notified/persisted twice)", () => {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-events-"));
  const db = openDatabase(join(dir, "test.sqlite3"));
  try {
    upsertSource(db, { id: "yellowpaper", name: "Yellow Paper", url: "https://x", kind: "html-flop", enabled: true });
    const snapshotId = insertSnapshot(db, {
      sourceId: "yellowpaper",
      fetchedAt: new Date().toISOString(),
      rawHash: "r",
      normalizedHash: "n",
      parseStatus: "ok",
      isBaseline: false,
    });
    const ctx = { ...CTX, snapshotId };

    const changes = [change({ category: "validator", field: "validator_min_stake", severity: "action_required" })];
    const firstRun = deriveEvents(changes, ctx);
    const secondRun = deriveEvents(changes, ctx); // simulates a crash-and-retry re-computing the same batch

    const firstInsertResults = firstRun.map((e) => insertEventIfNew(db, e));
    const secondInsertResults = secondRun.map((e) => insertEventIfNew(db, e));

    assert.ok(firstInsertResults.every((wasNew) => wasNew === true));
    assert.ok(secondInsertResults.every((wasNew) => wasNew === false));
    assert.equal(getRecentEvents(db, 100).length, firstRun.length);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
