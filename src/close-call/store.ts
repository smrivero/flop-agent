/**
 * Close Call local state: its own SQLite file (CLOSECALL_DB_PATH, default
 * .data/close-call.sqlite3), separate from every other module's database.
 *
 * Why SQLite (better-sqlite3, already used by mentions, verifier, tclk-marketplace
 * and protocol-watcher): per-room cursors and per-sweep rows must update
 * atomically, the observer and the paper trader restart often, and everything has
 * to be auditable with plain SQL. The referee posts are ALSO appended verbatim to
 * <rawLogDir>/raw-YYYY-MM-DD.jsonl (one line per message, exactly as read), so any
 * number in the database can be traced back to the bytes the referee published.
 *
 * Paper trading state is not stored as balances: paper_sweeps keeps the trades we
 * fed to the fold, and balances are always rebuilt by replaying them through the
 * official fold on start.
 */

import Database from "better-sqlite3";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type CcDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (
  room TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, generation INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS raw_posts (
  room TEXT NOT NULL, seq INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0, ts TEXT, from_did TEXT,
  text TEXT NOT NULL, nonce TEXT, sig TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (room, generation, seq));
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, since INTEGER NOT NULL, first_seq INTEGER NOT NULL,
  lost INTEGER NOT NULL, detected_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY CHECK (id = 1), price TEXT, tid TEXT, time TEXT, package TEXT, json TEXT);
CREATE TABLE IF NOT EXISTS sweeps (
  n INTEGER PRIMARY KEY,
  ref_px TEXT, ref_tid TEXT, ref_time TEXT, applied TEXT, lim_lo TEXT, lim_hi TEXT, lim_for INTEGER, age_s INTEGER,
  global TEXT, file TEXT,
  mints_listed INTEGER, rooms_new TEXT, settled_listed INTEGER, void_listed INTEGER, omitted TEXT, missed TEXT,
  open TEXT, longs INTEGER, shorts INTEGER, pos_top TEXT,
  mark TEXT, pnl_top TEXT,
  owners INTEGER, rooms INTEGER, root TEXT,
  price_json TEXT, flow_json TEXT, positions_json TEXT, pnl_json TEXT, state_json TEXT,
  first_seen_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS settled_ids (id TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hl_trades (tid TEXT PRIMARY KEY, px TEXT NOT NULL, time_ms INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS estimates (
  n INTEGER PRIMARY KEY, source TEXT, used TEXT, estimated_close TEXT, ref_prev TEXT, hl_px TEXT, hl_tid TEXT, hl_age_ms INTEGER,
  referee_age_s INTEGER, stale INTEGER, decided_at TEXT,
  actual_close TEXT, actual_tid TEXT, error TEXT, error_bps REAL, hl_last_before_boundary TEXT, hl_matches_ref INTEGER, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, did TEXT NOT NULL UNIQUE, key_path TEXT, fake INTEGER NOT NULL, registered INTEGER NOT NULL DEFAULT 0,
  minted INTEGER NOT NULL DEFAULT 0, minted_sweep INTEGER, mint_evidence TEXT, status TEXT NOT NULL, strategy_role TEXT, pair_index INTEGER,
  entry_reference TEXT, entry_sweep INTEGER, entry_px TEXT, error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY, sweep INTEGER NOT NULL, pair_index INTEGER, trigger TEXT, favored TEXT,
  maker_id TEXT, taker_id TEXT, maker_did TEXT, taker_did TEXT, side TEXT, qty TEXT, px TEXT, until INTEGER,
  ref TEXT, lim_lo TEXT, lim_hi TEXT, estimated_close TEXT, estimator TEXT, price_margin REAL, qty_margin REAL,
  trade_id TEXT, terms TEXT, maker_signing TEXT, taker_signing TEXT, message_preview TEXT,
  expected_maker_fee TEXT, expected_taker_fee TEXT, expected_maker_collateral TEXT, expected_taker_collateral TEXT,
  risk_status TEXT, risk_detail TEXT, created_at TEXT NOT NULL,
  outcome TEXT, reason TEXT, actual_close TEXT, actual_maker_fee TEXT, actual_taker_fee TEXT, prediction_error_bps REAL,
  ts_predicted_outcome TEXT, lookahead_px TEXT, lookahead_qty TEXT, lookahead_outcome TEXT, result_at TEXT);
CREATE TABLE IF NOT EXISTS paper_sweeps (n INTEGER PRIMARY KEY, ref TEXT NOT NULL, close TEXT NOT NULL, owners TEXT NOT NULL,
  trades TEXT NOT NULL, fold_result TEXT NOT NULL, lookahead_trades TEXT, lookahead_result TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS strategy_state (name TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms_state (
  name TEXT PRIMARY KEY, status TEXT NOT NULL, owner_did TEXT, evidence TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcile (
  id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER, level TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
`;

/**
 * Schema migrations, applied in order and recorded in PRAGMA user_version.
 * v1 is the original schema (every statement idempotent, so a database created
 * before versioning upgrades cleanly). Never edit a shipped migration: add one.
 */
const MIGRATIONS: { version: number; name: string; up: (db: CcDb) => void }[] = [
  { version: 1, name: "initial schema", up: (db) => db.exec(SCHEMA) },
  {
    version: 2,
    name: "lifecycle, trades, write journal, nonces, health, alerts",
    up: (db) => {
      const cols = (db.prepare("PRAGMA table_info(keys)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("mint_evidence")) db.exec("ALTER TABLE keys ADD COLUMN mint_evidence TEXT");
      if (!cols.includes("probe_trade_id")) db.exec("ALTER TABLE keys ADD COLUMN probe_trade_id TEXT");
      db.exec(`
        UPDATE keys SET status = 'MINT_CONFIRMED' WHERE status = 'MINTED';
        CREATE TABLE IF NOT EXISTS trades (
          trade_id TEXT PRIMARY KEY, kind TEXT NOT NULL, sweep_first INTEGER NOT NULL, until INTEGER NOT NULL,
          maker_id TEXT NOT NULL, taker_id TEXT NOT NULL, side TEXT NOT NULL, qty TEXT NOT NULL, px TEXT NOT NULL,
          terms TEXT NOT NULL, status TEXT NOT NULL, outcome_sweep INTEGER, reason TEXT, maker_fee TEXT, taker_fee TEXT,
          evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS write_attempts (
          attempt_id TEXT PRIMARY KEY, op_key TEXT NOT NULL, kind TEXT NOT NULL, room TEXT, ns TEXT, note_key TEXT,
          signer_id TEXT NOT NULL, nonce TEXT NOT NULL, payload_sha256 TEXT NOT NULL, body TEXT NOT NULL,
          state TEXT NOT NULL, http_status INTEGER, response TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS write_attempts_op ON write_attempts (op_key);
        CREATE INDEX IF NOT EXISTS write_attempts_state ON write_attempts (state);
        CREATE TABLE IF NOT EXISTS nonces (
          signer_id TEXT NOT NULL, scope TEXT NOT NULL, last_nonce TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (signer_id, scope));
        CREATE TABLE IF NOT EXISTS positions (
          n INTEGER NOT NULL, key_id TEXT NOT NULL, book TEXT NOT NULL, cash TEXT NOT NULL, position TEXT NOT NULL,
          fees TEXT NOT NULL, value TEXT, mark TEXT, at TEXT NOT NULL, PRIMARY KEY (n, key_id, book));
        CREATE TABLE IF NOT EXISTS strategy_triggers (
          id INTEGER PRIMARY KEY AUTOINCREMENT, sweep INTEGER NOT NULL, strategy TEXT NOT NULL, trigger TEXT NOT NULL,
          pair_index INTEGER, estimate TEXT, policy TEXT, decision TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS health_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
          detail TEXT, delivered TEXT NOT NULL, at TEXT NOT NULL);
      `);
    },
  },
  {
    version: 3,
    name: "void ids listed by the referee",
    up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS void_ids (id TEXT NOT NULL, n INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (id, n, reason))`),
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class DbIntegrityError extends Error {}

export function openCloseCallDb(path: string, opts: { checkIntegrity?: boolean } = {}): CcDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  if (opts.checkIntegrity) {
    const res = db.pragma("integrity_check", { simple: true });
    if (res !== "ok") {
      db.close();
      throw new DbIntegrityError(`integrity_check failed: ${String(res)}`);
    }
  }
  migrate(db);
  return db;
}

export function migrate(db: CcDb): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return db.pragma("user_version", { simple: true }) as number;
}

/** Consistent online backup (SQLite backup API; safe while the service writes). */
export async function backupDb(db: CcDb, destPath: string): Promise<{ path: string; pages: number }> {
  mkdirSync(dirname(destPath), { recursive: true });
  const r = await db.backup(destPath);
  return { path: destPath, pages: r.totalPages };
}

export function healthEvent(db: CcDb, kind: string, detail: unknown = null): void {
  db.prepare("INSERT INTO health_events (kind, detail, at) VALUES (?, ?, ?)").run(kind, detail === null ? null : JSON.stringify(detail), now());
}

export const now = () => new Date().toISOString();

export function getMeta(db: CcDb, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setMeta(db: CcDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getCursor(db: CcDb, room: string): { last_seq: number; generation: number | null } | null {
  return (db.prepare("SELECT last_seq, generation FROM cursors WHERE room = ?").get(room) as
    { last_seq: number; generation: number | null } | undefined) ?? null;
}

export function setCursor(db: CcDb, room: string, lastSeq: number, generation: number | null): void {
  db.prepare(`INSERT INTO cursors (room, last_seq, generation, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room) DO UPDATE SET last_seq = excluded.last_seq, generation = excluded.generation, updated_at = excluded.updated_at`)
    .run(room, lastSeq, generation, now());
}

export function appendRaw(dir: string, record: unknown): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `raw-${now().slice(0, 10)}.jsonl`), JSON.stringify(record) + "\n");
}

export function saveStrategyState(db: CcDb, name: string, state: unknown): void {
  db.prepare(`INSERT INTO strategy_state (name, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(name, JSON.stringify(state), now());
}

export function loadStrategyState<T>(db: CcDb, name: string): T | null {
  const r = db.prepare("SELECT json FROM strategy_state WHERE name = ?").get(name) as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as T) : null;
}

export function recordReconcile(db: CcDb, n: number | null, level: string, status: "OK" | "MISMATCH", detail: unknown): void {
  db.prepare("INSERT INTO reconcile (n, level, status, detail, at) VALUES (?, ?, ?, ?, ?)")
    .run(n, level, status, JSON.stringify(detail), now());
}
