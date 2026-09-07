/**
 * Own SQLite file (PROTOCOL_WATCHER_DB_PATH, default
 * .data/protocol-watcher.sqlite3) -- deliberately not shared with
 * mentions.sqlite3 or the marketplace's own DB (no technical reason to mix
 * them; same call the marketplace worker already made for itself). Same
 * conventions as mentions/database.ts: better-sqlite3, WAL mode, additive
 * `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` migrations that
 * never drop or rewrite existing rows.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ExtractionCategory,
  ExtractionItem,
  ExtractionStatus,
  ProtocolChange,
  ProtocolEvent,
  ProtocolSource,
} from "./types.js";

export type ProtocolWatcherDb = Database.Database;

export function openDatabase(path: string): ProtocolWatcherDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function tableColumns(db: ProtocolWatcherDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function addColumnsIfMissing(db: ProtocolWatcherDb, table: string, columns: [string, string][]): void {
  const current = tableColumns(db, table);
  for (const [name, type] of columns) {
    if (!current.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function migrate(db: ProtocolWatcherDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS protocol_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS protocol_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        declared_version TEXT,
        declared_updated_at TEXT,
        http_status INTEGER,
        etag TEXT,
        last_modified TEXT,
        raw_hash TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        raw_content_path TEXT,
        normalized_content_path TEXT,
        parse_status TEXT NOT NULL,
        parse_error TEXT,
        FOREIGN KEY(source_id) REFERENCES protocol_sources(id)
    );

    CREATE TABLE IF NOT EXISTS protocol_extractions (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        item_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_section TEXT,
        extraction_status TEXT NOT NULL,
        extraction_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(snapshot_id, category, item_key),
        FOREIGN KEY(snapshot_id) REFERENCES protocol_snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS protocol_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        previous_snapshot_id INTEGER,
        current_snapshot_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        item_id TEXT,
        field TEXT,
        change_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        previous_value_json TEXT,
        current_value_json TEXT,
        evidence_json TEXT NOT NULL,
        change_batch_id TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        FOREIGN KEY(current_snapshot_id) REFERENCES protocol_snapshots(id),
        FOREIGN KEY(previous_snapshot_id) REFERENCES protocol_snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS protocol_events (
        id INTEGER PRIMARY KEY,
        event_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        snapshot_id INTEGER,
        change_batch_id TEXT,
        severity TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        handled_at TEXT,
        FOREIGN KEY(snapshot_id) REFERENCES protocol_snapshots(id)
    );

    CREATE TABLE IF NOT EXISTS protocol_notifications (
        id INTEGER PRIMARY KEY,
        change_batch_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        destination TEXT,
        status TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        delivered_at TEXT,
        error TEXT
    );
  `);

  // -- additive migrations onto pre-existing tables --------------------------
  addColumnsIfMissing(db, "protocol_sources", [
    ["consecutive_errors", "INTEGER NOT NULL DEFAULT 0"],
    ["last_error", "TEXT"],
    ["last_attempted_at", "TEXT"],
    ["last_success_at", "TEXT"],
  ]);
  addColumnsIfMissing(db, "protocol_snapshots", [["is_baseline", "INTEGER NOT NULL DEFAULT 0"]]);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_events_idempotency ON protocol_events(idempotency_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_snapshots_source ON protocol_snapshots(source_id, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_changes_batch ON protocol_changes(change_batch_id)`);
}

// -- sources ------------------------------------------------------------------

export function upsertSource(db: ProtocolWatcherDb, source: ProtocolSource): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO protocol_sources (id, name, url, enabled, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, enabled = excluded.enabled,
       source_type = excluded.source_type, updated_at = excluded.updated_at`,
  ).run(source.id, source.name, source.url, source.enabled ? 1 : 0, source.kind, now, now);
}

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  enabled: number;
  source_type: string;
  created_at: string;
  updated_at: string;
  consecutive_errors: number;
  last_error: string | null;
  last_attempted_at: string | null;
  last_success_at: string | null;
}

export function getSource(db: ProtocolWatcherDb, sourceId: string): SourceRow | undefined {
  return db.prepare(`SELECT * FROM protocol_sources WHERE id = ?`).get(sourceId) as SourceRow | undefined;
}

export function listSources(db: ProtocolWatcherDb): SourceRow[] {
  return db.prepare(`SELECT * FROM protocol_sources ORDER BY id`).all() as SourceRow[];
}

export function recordFetchAttempt(db: ProtocolWatcherDb, sourceId: string, outcome: { success: boolean; error?: string }): void {
  const now = new Date().toISOString();
  if (outcome.success) {
    db.prepare(
      `UPDATE protocol_sources SET consecutive_errors = 0, last_error = NULL, last_attempted_at = ?, last_success_at = ? WHERE id = ?`,
    ).run(now, now, sourceId);
  } else {
    db.prepare(
      `UPDATE protocol_sources SET consecutive_errors = consecutive_errors + 1, last_error = ?, last_attempted_at = ? WHERE id = ?`,
    ).run(outcome.error ?? "unknown error", now, sourceId);
  }
}

// -- snapshots ------------------------------------------------------------------

export interface SnapshotRow {
  id: number;
  source_id: string;
  fetched_at: string;
  declared_version: string | null;
  declared_updated_at: string | null;
  http_status: number | null;
  etag: string | null;
  last_modified: string | null;
  raw_hash: string;
  normalized_hash: string;
  raw_content_path: string | null;
  normalized_content_path: string | null;
  parse_status: string;
  parse_error: string | null;
  is_baseline: number;
}

export interface NewSnapshot {
  sourceId: string;
  fetchedAt: string;
  declaredVersion?: string;
  declaredUpdatedAt?: string;
  httpStatus?: number;
  etag?: string;
  lastModified?: string;
  rawHash: string;
  normalizedHash: string;
  rawContentPath?: string;
  normalizedContentPath?: string;
  parseStatus: "ok" | "partial" | "failed";
  parseError?: string;
  isBaseline: boolean;
}

export function getLatestSnapshot(db: ProtocolWatcherDb, sourceId: string): SnapshotRow | undefined {
  return db
    .prepare(`SELECT * FROM protocol_snapshots WHERE source_id = ? ORDER BY id DESC LIMIT 1`)
    .get(sourceId) as SnapshotRow | undefined;
}

export function insertSnapshot(db: ProtocolWatcherDb, s: NewSnapshot): number {
  const result = db
    .prepare(
      `INSERT INTO protocol_snapshots
         (source_id, fetched_at, declared_version, declared_updated_at, http_status, etag, last_modified,
          raw_hash, normalized_hash, raw_content_path, normalized_content_path, parse_status, parse_error, is_baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.sourceId,
      s.fetchedAt,
      s.declaredVersion ?? null,
      s.declaredUpdatedAt ?? null,
      s.httpStatus ?? null,
      s.etag ?? null,
      s.lastModified ?? null,
      s.rawHash,
      s.normalizedHash,
      s.rawContentPath ?? null,
      s.normalizedContentPath ?? null,
      s.parseStatus,
      s.parseError ?? null,
      s.isBaseline ? 1 : 0,
    );
  return Number(result.lastInsertRowid);
}

/** Refreshes only the cache-validator columns on an existing snapshot (no
 * content/hash change, so no new row) -- keeps future conditional requests
 * using the server's latest ETag/Last-Modified instead of a stale one that
 * would just force a full re-fetch every run. */
export function touchSnapshotCache(db: ProtocolWatcherDb, snapshotId: number, etag: string | undefined, lastModified: string | undefined): void {
  db.prepare(`UPDATE protocol_snapshots SET etag = ?, last_modified = ? WHERE id = ?`).run(etag ?? null, lastModified ?? null, snapshotId);
}

/** Every hash still referenced by any snapshot row -- used by storage.ts's
 * retention sweep to decide which content files are safe to delete. */
export function referencedContentHashes(db: ProtocolWatcherDb): Set<string> {
  const rows = db.prepare(`SELECT raw_hash, normalized_hash FROM protocol_snapshots`).all() as {
    raw_hash: string;
    normalized_hash: string;
  }[];
  const set = new Set<string>();
  for (const r of rows) {
    set.add(r.raw_hash);
    set.add(r.normalized_hash);
  }
  return set;
}

// -- extractions ------------------------------------------------------------------

export interface ExtractionRow {
  id: number;
  snapshot_id: number;
  category: ExtractionCategory;
  item_key: string;
  value_json: string;
  source_section: string | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  created_at: string;
}

export function insertExtractions(db: ProtocolWatcherDb, snapshotId: number, items: ExtractionItem[]): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO protocol_extractions (snapshot_id, category, item_key, value_json, source_section, extraction_status, extraction_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_id, category, item_key) DO UPDATE SET
       value_json = excluded.value_json, source_section = excluded.source_section,
       extraction_status = excluded.extraction_status, extraction_error = excluded.extraction_error`,
  );
  const insertAll = db.transaction((rows: ExtractionItem[]) => {
    for (const item of rows) {
      stmt.run(
        snapshotId,
        item.category,
        item.itemKey,
        JSON.stringify(item.value),
        item.sourceSection ?? null,
        item.status,
        item.error ?? null,
        now,
      );
    }
  });
  insertAll(items);
}

export function getExtractions(db: ProtocolWatcherDb, snapshotId: number): ExtractionRow[] {
  return db.prepare(`SELECT * FROM protocol_extractions WHERE snapshot_id = ? ORDER BY category, item_key`).all(snapshotId) as ExtractionRow[];
}

export function getLatestExtractionsForSource(db: ProtocolWatcherDb, sourceId: string): ExtractionRow[] {
  const latest = getLatestSnapshot(db, sourceId);
  if (!latest) return [];
  return getExtractions(db, latest.id);
}

// -- changes ------------------------------------------------------------------

export function insertChange(db: ProtocolWatcherDb, change: ProtocolChange, changeBatchId: string, previousSnapshotId: number | null, currentSnapshotId: number): number {
  const result = db
    .prepare(
      `INSERT INTO protocol_changes
         (source_id, previous_snapshot_id, current_snapshot_id, category, item_id, field, change_type, severity,
          previous_value_json, current_value_json, evidence_json, change_batch_id, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      change.sourceId,
      previousSnapshotId,
      currentSnapshotId,
      change.category,
      change.itemId ?? null,
      change.field ?? null,
      change.changeType,
      change.severity,
      change.previousValue === undefined ? null : JSON.stringify(change.previousValue),
      change.currentValue === undefined ? null : JSON.stringify(change.currentValue),
      JSON.stringify(change.evidence),
      changeBatchId,
      change.detectedAt,
    );
  return Number(result.lastInsertRowid);
}

export interface ChangeRow {
  id: number;
  source_id: string;
  previous_snapshot_id: number | null;
  current_snapshot_id: number;
  category: string;
  item_id: string | null;
  field: string | null;
  change_type: string;
  severity: string;
  previous_value_json: string | null;
  current_value_json: string | null;
  evidence_json: string;
  change_batch_id: string;
  detected_at: string;
}

export function getChangesForBatch(db: ProtocolWatcherDb, changeBatchId: string): ChangeRow[] {
  return db.prepare(`SELECT * FROM protocol_changes WHERE change_batch_id = ? ORDER BY id`).all(changeBatchId) as ChangeRow[];
}

export function getLatestChanges(db: ProtocolWatcherDb, sourceId: string | undefined, limit: number): ChangeRow[] {
  if (sourceId) {
    return db
      .prepare(`SELECT * FROM protocol_changes WHERE source_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sourceId, limit) as ChangeRow[];
  }
  return db.prepare(`SELECT * FROM protocol_changes ORDER BY id DESC LIMIT ?`).all(limit) as ChangeRow[];
}

// -- events ------------------------------------------------------------------

/** Deterministic idempotency key: the same (event type, source, batch) never
 * inserts twice, even if multiple underlying changes in this run would
 * otherwise trigger it repeatedly. */
export function eventIdempotencyKey(eventType: string, sourceId: string, changeBatchId: string): string {
  return `${eventType}:${sourceId}:${changeBatchId}`;
}

/** Returns true if a new row was inserted, false if it already existed
 * (idempotent re-emit -- the caller should still log it, just not notify
 * twice). */
export function insertEventIfNew(db: ProtocolWatcherDb, event: ProtocolEvent): boolean {
  const key = eventIdempotencyKey(event.eventType, event.sourceId, event.changeBatchId);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO protocol_events (event_type, source_id, snapshot_id, change_batch_id, severity, payload_json, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(event.eventType, event.sourceId, event.snapshotId ?? null, event.changeBatchId, event.severity, JSON.stringify(event.payload), key, now);
  return result.changes > 0;
}

export interface EventRow {
  id: number;
  event_type: string;
  source_id: string;
  snapshot_id: number | null;
  change_batch_id: string | null;
  severity: string;
  payload_json: string;
  idempotency_key: string;
  created_at: string;
  handled_at: string | null;
}

export function getRecentEvents(db: ProtocolWatcherDb, limit: number): EventRow[] {
  return db.prepare(`SELECT * FROM protocol_events ORDER BY id DESC LIMIT ?`).all(limit) as EventRow[];
}

// -- notifications ------------------------------------------------------------------

export interface NewNotification {
  changeBatchId: string;
  channel: "telegram" | "technocore";
  destination?: string;
  status: "sent" | "failed" | "skipped" | "dry_run";
  attemptedAt: string;
  deliveredAt?: string;
  error?: string;
}

export function insertNotification(db: ProtocolWatcherDb, n: NewNotification): void {
  db.prepare(
    `INSERT INTO protocol_notifications (change_batch_id, channel, destination, status, attempted_at, delivered_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(n.changeBatchId, n.channel, n.destination ?? null, n.status, n.attemptedAt, n.deliveredAt ?? null, n.error ?? null);
}

export interface NotificationRow {
  id: number;
  change_batch_id: string;
  channel: string;
  destination: string | null;
  status: string;
  attempted_at: string;
  delivered_at: string | null;
  error: string | null;
}

export function getRecentNotifications(db: ProtocolWatcherDb, limit: number): NotificationRow[] {
  return db.prepare(`SELECT * FROM protocol_notifications ORDER BY id DESC LIMIT ?`).all(limit) as NotificationRow[];
}

// -- retention ------------------------------------------------------------------

export interface RetentionCandidate {
  id: number;
  raw_hash: string;
  normalized_hash: string;
}

/**
 * Snapshot rows safe to prune: older than the cutoff, NOT the latest snapshot
 * for their source (status/diff always need the latest), and not referenced
 * by any protocol_changes row (evidence trail stays intact). Deleting a
 * candidate's own extractions is the caller's job (deleteSnapshots), done in
 * the same transaction.
 */
export function findPrunableSnapshots(db: ProtocolWatcherDb, cutoffIso: string): RetentionCandidate[] {
  return db
    .prepare(
      `SELECT id, raw_hash, normalized_hash FROM protocol_snapshots
       WHERE fetched_at < ?
         AND id NOT IN (SELECT MAX(id) FROM protocol_snapshots GROUP BY source_id)
         AND id NOT IN (SELECT current_snapshot_id FROM protocol_changes)
         AND id NOT IN (SELECT previous_snapshot_id FROM protocol_changes WHERE previous_snapshot_id IS NOT NULL)`,
    )
    .all(cutoffIso) as RetentionCandidate[];
}

export function deleteSnapshots(db: ProtocolWatcherDb, ids: number[]): void {
  if (ids.length === 0) return;
  const del = db.transaction((idList: number[]) => {
    const placeholders = idList.map(() => "?").join(",");
    db.prepare(`DELETE FROM protocol_extractions WHERE snapshot_id IN (${placeholders})`).run(...idList);
    db.prepare(`DELETE FROM protocol_snapshots WHERE id IN (${placeholders})`).run(...idList);
  });
  del(ids);
}
