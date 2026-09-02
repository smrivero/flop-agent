import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openTclkMarketDatabase } from "./database.js";

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "flop-agent-tclk-mkt-db-")), name);
}

// Regression: a real deployment had rows in tclk_market_frames written before
// the `posted_at` column existed (NULL after the additive ALTER TABLE) --
// worker.ts's fold fell back to Date.now() for exactly those rows forever,
// which is the same bug the column exists to fix. openTclkMarketDatabase must
// backfill posted_at from received_at for any pre-existing NULL row, not just
// add the column.
test("migration: backfills posted_at from received_at for rows written before the column existed", () => {
  const path = tempPath("legacy.sqlite3");

  // Simulate a pre-migration DB: create the OLD schema (no posted_at) by hand
  // and insert a row the way the old code would have, then open it through
  // the real migration path.
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE tclk_market_frames (
        room TEXT NOT NULL, seq INTEGER NOT NULL, from_did TEXT NOT NULL, frame_type TEXT NOT NULL,
        contract_id TEXT, offer_id TEXT, frame_json TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (room, seq)
    );
  `);
  raw.prepare(`INSERT INTO tclk_market_frames (room, seq, from_did, frame_type, contract_id, offer_id, frame_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "tclk-offers", 1, "did:key:z6Mktest", "accept", "0xabc", null, "{}", "2026-01-01T00:00:00.000Z",
  );
  raw.close();

  const db = openTclkMarketDatabase(path);
  const row = db.prepare(`SELECT posted_at, received_at FROM tclk_market_frames WHERE room = 'tclk-offers' AND seq = 1`).get() as {
    posted_at: string | null;
    received_at: string;
  };
  assert.equal(row.posted_at, row.received_at);
  db.close();
});

test("migration: never overwrites posted_at for a row that already has it", () => {
  const path = tempPath("fresh.sqlite3");
  const db = openTclkMarketDatabase(path);
  db.prepare(
    `INSERT INTO tclk_market_frames (room, seq, from_did, frame_type, contract_id, offer_id, frame_json, received_at, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("tclk-offers", 1, "did:key:z6Mktest", "accept", "0xabc", null, "{}", "2026-06-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.close();

  const reopened = openTclkMarketDatabase(path); // re-runs migrate()
  const row = reopened.prepare(`SELECT posted_at FROM tclk_market_frames WHERE room = 'tclk-offers' AND seq = 1`).get() as { posted_at: string };
  assert.equal(row.posted_at, "2026-01-01T00:00:00.000Z"); // untouched -- not overwritten by received_at
  reopened.close();
});
