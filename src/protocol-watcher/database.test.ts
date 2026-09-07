import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  upsertSource,
  getSource,
  recordFetchAttempt,
  insertSnapshot,
  getLatestSnapshot,
  insertExtractions,
  getExtractions,
  insertChange,
  getChangesForBatch,
  insertEventIfNew,
  getRecentEvents,
  insertNotification,
  getRecentNotifications,
  findPrunableSnapshots,
  deleteSnapshots,
  referencedContentHashes,
} from "./database.js";
import type { ProtocolChange, ProtocolEvent } from "./types.js";

function withDb(fn: (db: ReturnType<typeof openDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-db-"));
  const db = openDatabase(join(dir, "test.sqlite3"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("database: upsertSource is idempotent and updates in place", () => {
  withDb((db) => {
    upsertSource(db, { id: "yellowpaper", name: "Yellow Paper", url: "https://x/1", kind: "html-flop", enabled: true });
    upsertSource(db, { id: "yellowpaper", name: "Yellow Paper v2", url: "https://x/2", kind: "html-flop", enabled: true });
    const row = getSource(db, "yellowpaper");
    assert.equal(row?.name, "Yellow Paper v2");
    assert.equal(row?.url, "https://x/2");
  });
});

test("database: recordFetchAttempt tracks consecutive errors and resets on success", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    recordFetchAttempt(db, "s1", { success: false, error: "timeout" });
    recordFetchAttempt(db, "s1", { success: false, error: "timeout" });
    let row = getSource(db, "s1")!;
    assert.equal(row.consecutive_errors, 2);
    assert.equal(row.last_error, "timeout");

    recordFetchAttempt(db, "s1", { success: true });
    row = getSource(db, "s1")!;
    assert.equal(row.consecutive_errors, 0);
    assert.equal(row.last_error, null);
    assert.ok(row.last_success_at);
  });
});

test("database: insertSnapshot + getLatestSnapshot round-trip", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    const id = insertSnapshot(db, {
      sourceId: "s1",
      fetchedAt: new Date().toISOString(),
      rawHash: "raw1",
      normalizedHash: "norm1",
      parseStatus: "ok",
      isBaseline: true,
    });
    const latest = getLatestSnapshot(db, "s1");
    assert.equal(latest?.id, id);
    assert.equal(latest?.normalized_hash, "norm1");
    assert.equal(latest?.is_baseline, 1);
  });
});

test("database: insertExtractions upserts on (snapshot,category,item_key)", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    const snapshotId = insertSnapshot(db, {
      sourceId: "s1",
      fetchedAt: new Date().toISOString(),
      rawHash: "r",
      normalizedHash: "n",
      parseStatus: "ok",
      isBaseline: true,
    });
    insertExtractions(db, snapshotId, [
      { category: "tokenomics", itemKey: "genesis_supply", value: "100", status: "ok" },
    ]);
    insertExtractions(db, snapshotId, [
      { category: "tokenomics", itemKey: "genesis_supply", value: "200", status: "ok" },
    ]);
    const rows = getExtractions(db, snapshotId);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].value_json), "200");
  });
});

test("database: insertChange + getChangesForBatch", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    const snap = insertSnapshot(db, {
      sourceId: "s1",
      fetchedAt: new Date().toISOString(),
      rawHash: "r",
      normalizedHash: "n",
      parseStatus: "ok",
      isBaseline: false,
    });
    const change: ProtocolChange = {
      sourceId: "s1",
      detectedAt: new Date().toISOString(),
      category: "validator",
      itemId: "validator_min_stake",
      field: "value",
      previousValue: "100",
      currentValue: "200",
      changeType: "modified",
      severity: "action_required",
      evidence: { url: "https://x" },
    };
    insertChange(db, change, "batch-1", null, snap);
    const rows = getChangesForBatch(db, "batch-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].item_id, "validator_min_stake");
    assert.equal(JSON.parse(rows[0].current_value_json!), "200");
  });
});

test("database: insertEventIfNew is idempotent per (event_type, source_id, batch)", () => {
  withDb((db) => {
    const event: ProtocolEvent = {
      eventType: "FLOP_VALIDATOR_REQUIREMENTS_CHANGED",
      sourceId: "s1",
      changeBatchId: "batch-1",
      severity: "action_required",
      payload: { foo: "bar" },
    };
    const firstInsert = insertEventIfNew(db, event);
    const secondInsert = insertEventIfNew(db, event);
    assert.equal(firstInsert, true);
    assert.equal(secondInsert, false);
    const rows = getRecentEvents(db, 10);
    assert.equal(rows.length, 1);
  });
});

test("database: notifications persist a dry-run preview status", () => {
  withDb((db) => {
    insertNotification(db, {
      changeBatchId: "batch-1",
      channel: "telegram",
      status: "dry_run",
      attemptedAt: new Date().toISOString(),
    });
    const rows = getRecentNotifications(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "dry_run");
  });
});

test("database: retention never prunes the latest snapshot for a source", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    insertSnapshot(db, { sourceId: "s1", fetchedAt: old, rawHash: "r1", normalizedHash: "n1", parseStatus: "ok", isBaseline: true });
    const latestId = insertSnapshot(db, { sourceId: "s1", fetchedAt: old, rawHash: "r2", normalizedHash: "n2", parseStatus: "ok", isBaseline: false });

    const cutoff = new Date(Date.now() - 1 * 86400_000).toISOString();
    const candidates = findPrunableSnapshots(db, cutoff);
    assert.ok(!candidates.some((c) => c.id === latestId), "latest snapshot must never be a prune candidate");
    assert.equal(candidates.length, 1);
  });
});

test("database: retention never prunes a snapshot referenced by protocol_changes", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    const referenced = insertSnapshot(db, { sourceId: "s1", fetchedAt: old, rawHash: "r1", normalizedHash: "n1", parseStatus: "ok", isBaseline: true });
    const latest = insertSnapshot(db, { sourceId: "s1", fetchedAt: old, rawHash: "r2", normalizedHash: "n2", parseStatus: "ok", isBaseline: false });
    insertChange(
      db,
      {
        sourceId: "s1",
        detectedAt: old,
        category: "other",
        changeType: "modified",
        severity: "info",
        evidence: { url: "https://x" },
      },
      "batch-1",
      referenced,
      latest,
    );

    const cutoff = new Date(Date.now() - 1 * 86400_000).toISOString();
    const candidates = findPrunableSnapshots(db, cutoff);
    assert.equal(candidates.length, 0, "the referenced snapshot must not be prunable");
  });
});

test("database: deleteSnapshots removes the snapshot and its extractions", () => {
  withDb((db) => {
    upsertSource(db, { id: "s1", name: "S1", url: "https://x", kind: "html-flop", enabled: true });
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    const a = insertSnapshot(db, { sourceId: "s1", fetchedAt: old, rawHash: "r1", normalizedHash: "n1", parseStatus: "ok", isBaseline: true });
    insertSnapshot(db, { sourceId: "s1", fetchedAt: old, rawHash: "r2", normalizedHash: "n2", parseStatus: "ok", isBaseline: false });
    insertExtractions(db, a, [{ category: "metadata", itemKey: "name", value: "x", status: "ok" }]);

    deleteSnapshots(db, [a]);
    assert.equal(getExtractions(db, a).length, 0);
    assert.ok(!referencedContentHashes(db).has("r1"));
  });
});
