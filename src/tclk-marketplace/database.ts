/**
 * Durable local state for the TCLK Marketplace Worker. Its own SQLite file
 * (`TCLK_MKT_DB_PATH`, default `.data/tclk-marketplace.sqlite3`) -- deliberately
 * NOT the shared `mentions.sqlite3` src/tclk/database.ts layers onto: this
 * worker has nothing to do with Radar findings, and keeping it in its own file
 * is what makes "disabling TCLK never affects radar/debate" trivially true at
 * the storage layer too, not just the process layer.
 *
 * Five tables:
 *  - room_cursors        per-room incremental read position (`since=`), so the
 *                         scanner never re-reads a room from scratch.
 *  - frames               every tclk/1 frame this worker has locally verified,
 *                         across every room it reads (tclk-offers + every deal
 *                         room). This is what lets state be RE-DERIVED (fold via
 *                         tclk's own applyFrame) instead of trusted from memory,
 *                         while still only ever fetching deltas over the wire --
 *                         see dealManager.ts / scanner.ts.
 *  - offer_decisions      one row per offer id ever evaluated: ACCEPT / REJECT /
 *                         IGNORE + reason. Doubles as the "already processed"
 *                         idempotency guard and as the policy audit trail.
 *  - contracts             one row per contract this worker is a party to
 *                         (payer or payee), cache + idempotency index only --
 *                         same discipline as src/tclk/database.ts's own
 *                         tclk_contracts: never the authority on status.
 *  - published_offers      offers this worker itself posted.
 *  - counters               a single error counter row, for status reporting.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TclkMarketDb = Database.Database;

export function openTclkMarketDatabase(path: string): TclkMarketDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // The worker's own long-lived connection competes with short-lived readers
  // against the SAME file (tclk:status, a manual `--once` run, etc) -- WAL
  // lets concurrent reads through, but a write racing another write still
  // needs to wait rather than throw SQLITE_BUSY immediately.
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function tableColumns(db: TclkMarketDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function migrate(db: TclkMarketDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tclk_market_room_cursors (
        room TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tclk_market_frames (
        room TEXT NOT NULL,
        seq INTEGER NOT NULL,
        from_did TEXT NOT NULL,
        frame_type TEXT NOT NULL,
        contract_id TEXT,
        offer_id TEXT,
        frame_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        posted_at TEXT,
        PRIMARY KEY (room, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_tclk_market_frames_contract ON tclk_market_frames(contract_id);
    CREATE INDEX IF NOT EXISTS idx_tclk_market_frames_offer ON tclk_market_frames(offer_id);

    CREATE TABLE IF NOT EXISTS tclk_market_offer_decisions (
        offer_id TEXT PRIMARY KEY,
        from_did TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        contract_id TEXT,
        amount TEXT,
        asset TEXT,
        decided_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tclk_market_contracts (
        contract_id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL,
        role TEXT NOT NULL, -- 'payer' | 'payee'
        payer_did TEXT,
        payee_did TEXT,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        rail TEXT,
        job_proto TEXT,
        job_id TEXT,
        deal_room TEXT NOT NULL,
        cached_status TEXT NOT NULL,
        receipted INTEGER NOT NULL DEFAULT 0,
        claim_by_ms INTEGER NOT NULL,
        refund_after_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL,
        secret_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tclk_market_published_offers (
        offer_id TEXT PRIMARY KEY,
        job_proto TEXT,
        job_id TEXT,
        amount TEXT NOT NULL,
        asset TEXT NOT NULL,
        rails TEXT NOT NULL,
        posted_seq INTEGER NOT NULL,
        contract_id TEXT,
        status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'accepted' | 'closed'
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tclk_market_counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        errors INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO tclk_market_counters (id, errors) VALUES (1, 0);
  `);

  // Additive migration for a DB created before `posted_at` existed (the
  // CREATE TABLE above only applies to a brand-new file). Needed so
  // worker.ts's fold can evaluate each frame's time-bound guards
  // (expiresMs/refundAfterMs) against the moment that frame actually landed,
  // not against whatever "now" happens to be when the contract is re-folded
  // later -- see foldFromStore's own comment for why that distinction matters.
  if (!tableColumns(db, "tclk_market_frames").has("posted_at")) {
    db.exec(`ALTER TABLE tclk_market_frames ADD COLUMN posted_at TEXT`);
  }
  // Backfill rows written before the column existed: `posted_at IS NULL`
  // would otherwise keep falling back to Date.now() in loadContractFrames
  // forever, for exactly the frames this migration exists to fix.
  // `received_at` (when THIS worker first stored the frame locally) is at
  // worst a few seconds/minutes later than the frame's real room `ts` --
  // close enough that it still falls safely inside any deadline that was
  // only actually violated by hours of real time passing since.
  db.exec(`UPDATE tclk_market_frames SET posted_at = received_at WHERE posted_at IS NULL`);
}

// -- room cursors --------------------------------------------------------------

export function getRoomCursor(db: TclkMarketDb, room: string): number {
  const row = db.prepare(`SELECT last_seq FROM tclk_market_room_cursors WHERE room = ?`).get(room) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

export function setRoomCursor(db: TclkMarketDb, room: string, lastSeq: number): void {
  db.prepare(
    `INSERT INTO tclk_market_room_cursors (room, last_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(room) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
     WHERE excluded.last_seq > tclk_market_room_cursors.last_seq`,
  ).run(room, lastSeq, new Date().toISOString());
}

// -- frames ----------------------------------------------------------------------

export interface StoredFrame {
  room: string;
  seq: number;
  from_did: string;
  frame_type: string;
  contract_id: string | null;
  offer_id: string | null;
  frame_json: string;
  /** ISO timestamp of when the room message carrying this frame was actually
   * posted (the room's own `ts`, or our own post time for a frame we just
   * sent) -- what worker.ts's fold uses as `nowMs` for THIS frame's
   * `applyFrame` guards, instead of the moment it happens to be re-folded.
   * Null only for rows written before this column existed (see the additive
   * migration in migrate()); those fall back to the current clock. */
  posted_at: string | null;
}

/** Insert-or-ignore: a frame already stored for this (room, seq) is never
 * overwritten -- (room, seq) is a stable, unique identity for one message. */
export function storeFrame(db: TclkMarketDb, frame: StoredFrame): void {
  db.prepare(
    `INSERT OR IGNORE INTO tclk_market_frames (room, seq, from_did, frame_type, contract_id, offer_id, frame_json, received_at, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(frame.room, frame.seq, frame.from_did, frame.frame_type, frame.contract_id, frame.offer_id, frame.frame_json, new Date().toISOString(), frame.posted_at);
}

export function framesForContract(db: TclkMarketDb, contractId: string): StoredFrame[] {
  return db.prepare(`SELECT * FROM tclk_market_frames WHERE contract_id = ? ORDER BY seq ASC`).all(contractId) as StoredFrame[];
}

export function framesForOffer(db: TclkMarketDb, offerId: string): StoredFrame[] {
  return db.prepare(`SELECT * FROM tclk_market_frames WHERE offer_id = ? ORDER BY seq ASC`).all(offerId) as StoredFrame[];
}

export function offerFrameById(db: TclkMarketDb, offerId: string): StoredFrame | undefined {
  return db.prepare(`SELECT * FROM tclk_market_frames WHERE offer_id = ? AND frame_type = 'offer' ORDER BY seq ASC LIMIT 1`).get(offerId) as
    | StoredFrame
    | undefined;
}

// -- offer decisions (dedupe + audit trail) --------------------------------------

export type OfferDecisionKind = "ACCEPT" | "REJECT" | "IGNORE";

export interface OfferDecisionRow {
  offer_id: string;
  from_did: string;
  decision: OfferDecisionKind;
  reason: string;
  contract_id: string | null;
  amount: string | null;
  asset: string | null;
  decided_at: string;
}

export function getOfferDecision(db: TclkMarketDb, offerId: string): OfferDecisionRow | undefined {
  return db.prepare(`SELECT * FROM tclk_market_offer_decisions WHERE offer_id = ?`).get(offerId) as OfferDecisionRow | undefined;
}

export function recordOfferDecision(
  db: TclkMarketDb,
  fields: { offerId: string; fromDid: string; decision: OfferDecisionKind; reason: string; contractId?: string; amount?: string; asset?: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO tclk_market_offer_decisions (offer_id, from_did, decision, reason, contract_id, amount, asset, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(fields.offerId, fields.fromDid, fields.decision, fields.reason, fields.contractId ?? null, fields.amount ?? null, fields.asset ?? null, new Date().toISOString());
}

/** Offers REJECTed for a reason that is about OUR OWN capacity/config at the
 * moment, not the offer's own terms -- `max_concurrent_deals_reached` chiefly
 * -- so it can go stale the moment a deal completes and a slot frees up.
 * Everything else (unsupported_rail, unsupported_asset, missing_job, ...) is
 * permanent: the offer's own fields never change. */
const RETRYABLE_REJECT_REASONS = ["max_concurrent_deals_reached"] as const;

/** Offer ids REJECTed for a retryable reason -- worker.ts re-evaluates each
 * one fresh (from the already-cached offer frame, no network re-read needed)
 * every tick, so a transient rejection never becomes a permanent one. */
export function listRetryableRejections(db: TclkMarketDb): string[] {
  const placeholders = RETRYABLE_REJECT_REASONS.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT offer_id FROM tclk_market_offer_decisions WHERE decision = 'REJECT' AND reason IN (${placeholders})`)
    .all(...RETRYABLE_REJECT_REASONS) as { offer_id: string }[];
  return rows.map((r) => r.offer_id);
}

export function deleteOfferDecision(db: TclkMarketDb, offerId: string): void {
  db.prepare(`DELETE FROM tclk_market_offer_decisions WHERE offer_id = ?`).run(offerId);
}

// -- contracts ---------------------------------------------------------------------

export interface TclkMarketContractRow {
  contract_id: string;
  offer_id: string;
  role: "payer" | "payee";
  payer_did: string | null;
  payee_did: string | null;
  asset: string;
  amount: string;
  rail: string | null;
  job_proto: string | null;
  job_id: string | null;
  deal_room: string;
  cached_status: string;
  receipted: number;
  claim_by_ms: number;
  refund_after_ms: number;
  expires_ms: number;
  secret_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export function insertContract(
  db: TclkMarketDb,
  fields: Omit<TclkMarketContractRow, "created_at" | "updated_at" | "receipted"> & { receipted?: boolean },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO tclk_market_contracts
       (contract_id, offer_id, role, payer_did, payee_did, asset, amount, rail, job_proto, job_id, deal_room, cached_status, receipted, claim_by_ms, refund_after_ms, expires_ms, secret_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.contract_id,
    fields.offer_id,
    fields.role,
    fields.payer_did,
    fields.payee_did,
    fields.asset,
    fields.amount,
    fields.rail,
    fields.job_proto,
    fields.job_id,
    fields.deal_room,
    fields.cached_status,
    fields.receipted ? 1 : 0,
    fields.claim_by_ms,
    fields.refund_after_ms,
    fields.expires_ms,
    fields.secret_fingerprint,
    now,
    now,
  );
}

export function getContract(db: TclkMarketDb, contractId: string): TclkMarketContractRow | undefined {
  return db.prepare(`SELECT * FROM tclk_market_contracts WHERE contract_id = ?`).get(contractId) as TclkMarketContractRow | undefined;
}

const TERMINAL_DONE_STATUSES = new Set(["refunded_receipted", "cancelled_receipted"]);

/** Every contract this worker might still need to act on: not cached as a
 * fully-done terminal status. `claimed` and `refunded`/`cancelled` still need
 * a receipt step from whichever side reaches them first -- see dealManager.ts --
 * so only the explicit "*_receipted" markers this module writes (never a raw
 * tclk/1 status) drop a row out of this list. */
export function listOpenContracts(db: TclkMarketDb): TclkMarketContractRow[] {
  return db
    .prepare(
      `SELECT * FROM tclk_market_contracts WHERE cached_status NOT IN (${[...TERMINAL_DONE_STATUSES].map(() => "?").join(",")}) ORDER BY rowid ASC`,
    )
    .all(...TERMINAL_DONE_STATUSES) as TclkMarketContractRow[];
}

export function updateContractCache(
  db: TclkMarketDb,
  contractId: string,
  fields: Partial<{ cachedStatus: string; receipted: boolean; payerDid: string; payeeDid: string; rail: string; secretFingerprint: string }>,
): void {
  const columns: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.cachedStatus !== undefined) columns.cached_status = fields.cachedStatus;
  if (fields.receipted !== undefined) columns.receipted = fields.receipted ? 1 : 0;
  if (fields.payerDid !== undefined) columns.payer_did = fields.payerDid;
  if (fields.payeeDid !== undefined) columns.payee_did = fields.payeeDid;
  if (fields.rail !== undefined) columns.rail = fields.rail;
  if (fields.secretFingerprint !== undefined) columns.secret_fingerprint = fields.secretFingerprint;

  const names = Object.keys(columns);
  const setClause = names.map((n) => `${n} = ?`).join(", ");
  db.prepare(`UPDATE tclk_market_contracts SET ${setClause} WHERE contract_id = ?`).run(...names.map((n) => columns[n]), contractId);
}

export function countActiveContractsByRole(db: TclkMarketDb, role: "payer" | "payee"): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM tclk_market_contracts WHERE role = ? AND cached_status IN ('accepted', 'locked')`)
    .get(role) as { n: number };
  return row.n;
}

// -- published offers ------------------------------------------------------------

/**
 * Every offer we published that's still marked 'open' but whose own
 * `expiresMs` has passed is closed out (status='expired') -- otherwise it
 * counts against `TCLK_MKT_MAX_OPEN_OFFERS` forever, silently blocking
 * auto-publish long after the offer itself became un-acceptable to anyone.
 * Reads the cached offer frame (never the network) to get `expiresMs`; a row
 * whose frame isn't cached (shouldn't happen -- publisher.ts stores it
 * immediately) is left alone rather than guessed at.
 */
export function closeExpiredPublishedOffers(db: TclkMarketDb, now: number): number {
  const open = db.prepare(`SELECT offer_id FROM tclk_market_published_offers WHERE status = 'open'`).all() as { offer_id: string }[];
  let closed = 0;
  const update = db.prepare(`UPDATE tclk_market_published_offers SET status = 'expired', updated_at = ? WHERE offer_id = ?`);
  for (const { offer_id } of open) {
    const frameRow = offerFrameById(db, offer_id);
    if (frameRow === undefined) continue;
    let expiresMs: number | undefined;
    try {
      expiresMs = (JSON.parse(frameRow.frame_json) as { expiresMs?: number }).expiresMs;
    } catch {
      continue;
    }
    if (typeof expiresMs === "number" && now >= expiresMs) {
      update.run(new Date().toISOString(), offer_id);
      closed++;
    }
  }
  return closed;
}

export function insertPublishedOffer(
  db: TclkMarketDb,
  fields: { offerId: string; jobProto?: string; jobId?: string; amount: string; asset: string; rails: string[]; postedSeq: number },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tclk_market_published_offers (offer_id, job_proto, job_id, amount, asset, rails, posted_seq, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(fields.offerId, fields.jobProto ?? null, fields.jobId ?? null, fields.amount, fields.asset, fields.rails.join(","), fields.postedSeq, now, now);
}

export function markPublishedOfferAccepted(db: TclkMarketDb, offerId: string, contractId: string): void {
  db.prepare(`UPDATE tclk_market_published_offers SET status = 'accepted', contract_id = ?, updated_at = ? WHERE offer_id = ?`).run(
    contractId,
    new Date().toISOString(),
    offerId,
  );
}

export function countOpenPublishedOffers(db: TclkMarketDb): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM tclk_market_published_offers WHERE status = 'open'`).get() as { n: number };
  return row.n;
}

export function lastPublishedOfferAt(db: TclkMarketDb): number | undefined {
  const row = db.prepare(`SELECT created_at FROM tclk_market_published_offers ORDER BY created_at DESC LIMIT 1`).get() as
    | { created_at: string }
    | undefined;
  return row ? Date.parse(row.created_at) : undefined;
}

// -- counters --------------------------------------------------------------------

export function incrementErrorCounter(db: TclkMarketDb): void {
  db.prepare(`UPDATE tclk_market_counters SET errors = errors + 1 WHERE id = 1`).run();
}

export function getErrorCount(db: TclkMarketDb): number {
  const row = db.prepare(`SELECT errors FROM tclk_market_counters WHERE id = 1`).get() as { errors: number } | undefined;
  return row?.errors ?? 0;
}
