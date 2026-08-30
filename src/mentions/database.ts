/**
 * SQLite is the single source of truth for dedup and for query-rotation state, so
 * cron can pick up where the previous run left off. better-sqlite3 is synchronous,
 * which is enough correctness here: the file-lock (lock.ts) already guarantees at
 * most one process touches this database at a time -- WAL mode is enabled purely
 * as cheap insurance, not as the concurrency control.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Candidate, MentionRow, MentionStatus } from "./types.js";

export type MentionsDb = Database.Database;

export function openDatabase(path: string): MentionsDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: MentionsDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL UNIQUE,
        url_hash TEXT NOT NULL UNIQUE,
        original_url TEXT,
        title TEXT,
        domain TEXT,
        snippet TEXT,
        published_date TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT,
        technocore_room TEXT,
        technocore_message_id TEXT,
        summary TEXT,
        status TEXT NOT NULL,
        error TEXT
    );

    CREATE TABLE IF NOT EXISTS query_rotation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_index INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// -- dedup --------------------------------------------------------------------

export function isKnownUrl(db: MentionsDb, canonicalUrl: string, urlHash: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM mentions WHERE canonical_url = ? OR url_hash = ? LIMIT 1`)
    .get(canonicalUrl, urlHash);
  return row !== undefined;
}

export function insertDiscovered(db: MentionsDb, candidate: Candidate): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO mentions
         (canonical_url, url_hash, original_url, title, domain, snippet, published_date, discovered_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered')`,
    )
    .run(
      candidate.canonicalUrl,
      candidate.urlHash,
      candidate.originalUrl,
      candidate.title,
      candidate.domain,
      candidate.snippet,
      candidate.publishedDate ?? null,
      now,
    );
  return Number(result.lastInsertRowid);
}

function setStatus(db: MentionsDb, id: number, status: MentionStatus, fields: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  const columns = ["status = ?", "updated_at = ?", ...Object.keys(fields).map((k) => `${k} = ?`)];
  const values = [status, now, ...Object.values(fields), id];
  db.prepare(`UPDATE mentions SET ${columns.join(", ")} WHERE id = ?`).run(...values);
}

export function markPublished(db: MentionsDb, id: number, room: string, messageId: string, summary: string | null): void {
  setStatus(db, id, "published", { technocore_room: room, technocore_message_id: messageId, summary });
}

export function markRejected(db: MentionsDb, id: number, reason: string): void {
  setStatus(db, id, "rejected", { error: reason });
}

export function markPublishFailed(db: MentionsDb, id: number, error: string): void {
  setStatus(db, id, "publish_failed", { error });
}

export function markAnalysisFailed(db: MentionsDb, id: number, error: string): void {
  setStatus(db, id, "analysis_failed", { error });
}

export function getMention(db: MentionsDb, id: number): MentionRow | undefined {
  return db.prepare(`SELECT * FROM mentions WHERE id = ?`).get(id) as MentionRow | undefined;
}

/**
 * The persistent backlog: mentions found (in this run or an earlier one) that
 * never got resolved to published/rejected/failed, oldest first. This is what
 * makes "found 20, published 5" not lose the other 15 -- they stay `discovered`
 * and are exactly what this returns next time, ahead of brand-new results.
 */
export function getPendingBacklog(db: MentionsDb, limit: number): MentionRow[] {
  return db
    .prepare(`SELECT * FROM mentions WHERE status = 'discovered' ORDER BY discovered_at ASC, id ASC LIMIT ?`)
    .all(limit) as MentionRow[];
}

// -- query rotation -------------------------------------------------------------

/** Read-only: what the next batch would be, without moving the cursor. */
export function peekQueryBatch(db: MentionsDb, allQueries: string[], count: number): string[] {
  if (allQueries.length === 0) return [];
  const row = db.prepare(`SELECT next_index FROM query_rotation WHERE id = 1`).get() as { next_index: number } | undefined;
  const start = row?.next_index ?? 0;
  const batch: string[] = [];
  const n = Math.min(count, allQueries.length);
  for (let i = 0; i < n; i++) {
    batch.push(allQueries[(start + i) % allQueries.length]);
  }
  return batch;
}

/** Advance the rotation cursor by `count` (mod the query list length). */
export function advanceQueryRotation(db: MentionsDb, allQueries: string[], count: number): void {
  if (allQueries.length === 0) return;
  const row = db.prepare(`SELECT next_index FROM query_rotation WHERE id = 1`).get() as { next_index: number } | undefined;
  const start = row?.next_index ?? 0;
  const nextIndex = (start + Math.min(count, allQueries.length)) % allQueries.length;
  db.prepare(
    `INSERT INTO query_rotation (id, next_index) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET next_index = excluded.next_index`,
  ).run(nextIndex);
}
