/**
 * SQLite is the single source of truth for dedup, findings, and query-rotation
 * state, so cron can pick up where the previous run left off. better-sqlite3 is
 * synchronous, which is enough correctness here: the file-lock (lock.ts)
 * already guarantees at most one process touches this database at a time --
 * WAL mode is enabled purely as cheap insurance, not as the concurrency control.
 *
 * Migrations are additive and non-destructive: existing rows and their history
 * are never dropped or rewritten. `summary` was renamed to `finding` in place
 * (SQLite 3.25+ RENAME COLUMN, confirmed against the bundled 3.49) rather than
 * adding a second column that duplicates the same role.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { generateFindingId } from "./finding.js";
import type { Candidate, MentionRow, MentionStatus, RunSummary } from "./types.js";

export type MentionsDb = Database.Database;

export function openDatabase(path: string): MentionsDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function tableColumns(db: MentionsDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
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

  // -- additive migration onto a pre-existing `mentions` table --------------
  const columns = tableColumns(db, "mentions");

  if (columns.has("summary") && !columns.has("finding")) {
    db.exec(`ALTER TABLE mentions RENAME COLUMN summary TO finding`);
  }

  const toAdd: [string, string][] = [
    ["finding_id", "TEXT"],
    ["content_hash", "TEXT"],
    ["search_query", "TEXT"],
    ["search_provider", "TEXT"],
    ["checked_at", "TEXT"],
    ["published_at", "TEXT"],
  ];
  const current = tableColumns(db, "mentions"); // re-read post-rename
  for (const [name, type] of toAdd) {
    if (!current.has(name)) db.exec(`ALTER TABLE mentions ADD COLUMN ${name} ${type}`);
  }

  // Backfill: every pre-existing row (from before finding_id existed) gets one
  // too, derived from its own discovered_at + canonical_url -- so
  // --show-finding and a Bot B verifier work uniformly across old and new
  // findings alike. Deterministic and non-destructive: nothing else about the
  // row changes.
  const missingFindingId = db.prepare(`SELECT id, canonical_url, discovered_at FROM mentions WHERE finding_id IS NULL`).all() as {
    id: number;
    canonical_url: string;
    discovered_at: string;
  }[];
  if (missingFindingId.length > 0) {
    const backfill = db.prepare(`UPDATE mentions SET finding_id = ? WHERE id = ?`);
    const backfillAll = db.transaction((rows: typeof missingFindingId) => {
      for (const row of rows) {
        const discoveredAt = new Date(row.discovered_at);
        const findingId = generateFindingId(row.canonical_url, Number.isNaN(discoveredAt.getTime()) ? new Date() : discoveredAt);
        backfill.run(findingId, row.id);
      }
    });
    backfillAll(missingFindingId);
  }

  // finding_id needs to be unique, but ADD COLUMN can't declare UNIQUE directly
  // on SQLite (and existing rows would violate NOT NULL if it required one) --
  // a partial unique index over non-null values gets the same guarantee for
  // every row going forward (and every row now has one, per the backfill above).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_finding_id ON mentions(finding_id) WHERE finding_id IS NOT NULL`);

  // -- reproducibility / activity log (used by the optional daily status) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ran_at TEXT NOT NULL,
        queries INTEGER NOT NULL,
        results INTEGER NOT NULL,
        duplicates INTEGER NOT NULL,
        new_count INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        published INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS radar_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_daily_status_at TEXT
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

/** Inserts a newly-discovered candidate and assigns its (permanent) finding_id. */
export function insertDiscovered(db: MentionsDb, candidate: Candidate): number {
  const now = new Date();
  const nowIso = now.toISOString();
  const findingId = generateFindingId(candidate.canonicalUrl, now);
  const result = db
    .prepare(
      `INSERT INTO mentions
         (finding_id, canonical_url, url_hash, original_url, title, domain, snippet,
          published_date, search_query, search_provider, discovered_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')`,
    )
    .run(
      findingId,
      candidate.canonicalUrl,
      candidate.urlHash,
      candidate.originalUrl,
      candidate.title,
      candidate.domain,
      candidate.snippet,
      candidate.publishedDate ?? null,
      candidate.searchQuery,
      candidate.searchProvider,
      nowIso,
    );
  return Number(result.lastInsertRowid);
}

function setStatus(db: MentionsDb, id: number, status: MentionStatus, fields: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  const columns = ["status = ?", "updated_at = ?", ...Object.keys(fields).map((k) => `${k} = ?`)];
  const values = [status, now, ...Object.values(fields), id];
  db.prepare(`UPDATE mentions SET ${columns.join(", ")} WHERE id = ?`).run(...values);
}

export function markPublished(
  db: MentionsDb,
  id: number,
  room: string,
  messageId: string,
  finding: string | null,
  contentHash: string | null,
): void {
  const now = new Date().toISOString();
  setStatus(db, id, "published", {
    technocore_room: room,
    technocore_message_id: messageId,
    finding,
    content_hash: contentHash,
    checked_at: now,
    published_at: now,
  });
}

export function markRejected(db: MentionsDb, id: number, reason: string, contentHash: string | null): void {
  setStatus(db, id, "rejected", { error: reason, content_hash: contentHash, checked_at: new Date().toISOString() });
}

export function markPublishFailed(db: MentionsDb, id: number, error: string, finding: string | null, contentHash: string | null): void {
  setStatus(db, id, "publish_failed", { error, finding, content_hash: contentHash, checked_at: new Date().toISOString() });
}

export function markAnalysisFailed(db: MentionsDb, id: number, error: string): void {
  setStatus(db, id, "analysis_failed", { error, checked_at: new Date().toISOString() });
}

export function getMention(db: MentionsDb, id: number): MentionRow | undefined {
  return db.prepare(`SELECT * FROM mentions WHERE id = ?`).get(id) as MentionRow | undefined;
}

/** Bot B's (or anyone's) entry point: look a finding up by its public ID. Read-
 * only, no identity/network involved -- works from `--show-finding=<id>` or a
 * direct import if Bot B shares this SQLite file. */
export function getFindingByFindingId(db: MentionsDb, findingId: string): MentionRow | undefined {
  return db.prepare(`SELECT * FROM mentions WHERE finding_id = ?`).get(findingId) as MentionRow | undefined;
}

/**
 * The persistent, retryable backlog: mentions found (in this run or an earlier
 * one) that never reached a terminal published/rejected state, oldest first.
 * Includes `publish_failed` -- a finding that was generated correctly but
 * whose Technocore write failed keeps its `finding_id` and gets tried again,
 * rather than being generated fresh (and rather than being lost).
 */
export function getPendingBacklog(db: MentionsDb, limit: number): MentionRow[] {
  return db
    .prepare(
      `SELECT * FROM mentions WHERE status IN ('discovered', 'publish_failed')
       ORDER BY discovered_at ASC, id ASC LIMIT ?`,
    )
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

// -- reproducibility log / optional daily status --------------------------------

export function recordRun(db: MentionsDb, summary: RunSummary): void {
  db.prepare(
    `INSERT INTO run_log (ran_at, queries, results, duplicates, new_count, rejected, published)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), summary.queries, summary.results, summary.duplicates, summary.new, summary.rejected, summary.published);
}

export interface AggregatedActivity {
  searches: number;
  resultsInspected: number;
  duplicates: number;
  newFindings: number;
}

/** Real, measured totals from `run_log` over the last `hours` -- never invented. */
export function aggregateRecentActivity(db: MentionsDb, hours: number): AggregatedActivity {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(queries),0) AS searches, COALESCE(SUM(results),0) AS resultsInspected,
              COALESCE(SUM(duplicates),0) AS duplicates, COALESCE(SUM(new_count),0) AS newFindings
       FROM run_log WHERE ran_at >= ?`,
    )
    .get(since) as AggregatedActivity;
  return row;
}

export function getLastDailyStatusAt(db: MentionsDb): string | null {
  const row = db.prepare(`SELECT last_daily_status_at FROM radar_status WHERE id = 1`).get() as
    | { last_daily_status_at: string | null }
    | undefined;
  return row?.last_daily_status_at ?? null;
}

export function setLastDailyStatusAt(db: MentionsDb, when: Date): void {
  db.prepare(
    `INSERT INTO radar_status (id, last_daily_status_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_daily_status_at = excluded.last_daily_status_at`,
  ).run(when.toISOString());
}

export function countPublished(db: MentionsDb): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM mentions WHERE status = 'published'`).get() as { c: number };
  return row.c;
}

export function getLastPublished(db: MentionsDb): MentionRow | undefined {
  return db.prepare(`SELECT * FROM mentions WHERE status = 'published' ORDER BY published_at DESC LIMIT 1`).get() as
    | MentionRow
    | undefined;
}
