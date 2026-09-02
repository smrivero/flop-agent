/**
 * Local cache/index for TCLK contracts, layered onto the SAME shared SQLite
 * file Radar and the Verifier already use (own additive migration, like
 * verifier/database.ts does for `verifications` -- `mentions`/`query_rotation`/
 * `run_log`/`radar_status`/`verifications` are never touched).
 *
 * ONE row per finding_id, shared and updated collaboratively by BOTH workers
 * (Agent A writes offer/lock/receipt fields, Agent B writes accept/reveal
 * fields into the same row) -- exactly how `verifications` is already one
 * shared table both Radar and the Verifier read/write. There is no separate
 * "payer's view" vs "payee's view" row: this is one host, one repo, two
 * signing identities, sharing local storage, same as everywhere else here.
 *
 * IMPORTANT: this table is a cache and an idempotency index, never the
 * authority on contract state. Both workers (payer.ts / verifierWorker.ts)
 * always re-derive the actual `status` by folding the Technocore transcript
 * through tclk's own `applyFrame` before deciding what to do next -- see
 * transcript.ts. `cached_status` here exists only so a run can skip a
 * transcript re-scan for contracts already known to be finished, and so
 * humans/tests can inspect state without replaying frames by hand.
 */

import { openDatabase as openMentionsDatabase, type MentionsDb } from "../mentions/database.js";

export type TclkDb = MentionsDb;

export interface TclkContractRow {
  id: number;
  finding_id: string;
  tclk_contract_id: string | null;
  tclk_offer_id: string | null;
  cached_status: string;
  offer_message_id: string | null;
  accept_message_id: string | null;
  lock_message_id: string | null;
  verification_message_id: string | null;
  reveal_message_id: string | null;
  receipt_message_id: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Standalone open, for the two worker CLIs (which don't already hold a
 * connection to this file). `mentions/run.ts` instead calls `migrateTclkTables`
 * directly on the db handle it already has open, rather than opening a second
 * connection to the same file. */
export function openTclkDatabase(path: string): TclkDb {
  const db = openMentionsDatabase(path);
  migrateTclkTables(db);
  return db;
}

/** Run just the additive migration against an already-open db handle. */
export function migrateTclkTables(db: TclkDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tclk_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id TEXT NOT NULL UNIQUE,
        tclk_contract_id TEXT,
        tclk_offer_id TEXT,
        cached_status TEXT NOT NULL,
        offer_message_id TEXT,
        accept_message_id TEXT,
        lock_message_id TEXT,
        verification_message_id TEXT,
        reveal_message_id TEXT,
        receipt_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tclk_contracts_contract_id
      ON tclk_contracts(tclk_contract_id) WHERE tclk_contract_id IS NOT NULL;
  `);
}

export function getContractByFindingId(db: TclkDb, findingId: string): TclkContractRow | undefined {
  return db.prepare(`SELECT * FROM tclk_contracts WHERE finding_id = ?`).get(findingId) as TclkContractRow | undefined;
}

export function getContractByContractId(db: TclkDb, contractId: string): TclkContractRow | undefined {
  return db.prepare(`SELECT * FROM tclk_contracts WHERE tclk_contract_id = ?`).get(contractId) as TclkContractRow | undefined;
}

/**
 * Every contract either worker might still need to act on. Deliberately does
 * NOT exclude tclk's own `claimed` status: a claimed contract still needs
 * Agent A to issue a receipt, which is a step *this* project requires on top
 * of tclk/1 itself. `receipted` -- set only once that receipt is actually
 * posted (see payer.ts) -- is the local, fully-done marker that finally drops
 * a row out of this list; `refunded`/`cancelled` have no further step and are
 * excluded directly.
 */
export function listOpenContracts(db: TclkDb): TclkContractRow[] {
  return db
    .prepare(`SELECT * FROM tclk_contracts WHERE cached_status NOT IN ('refunded', 'cancelled', 'receipted') ORDER BY id ASC`)
    .all() as TclkContractRow[];
}

/** Agent A, right after posting the offer: creates the one-and-only row this
 * finding will ever have. A finding stays bound to exactly one TCLK contract,
 * forever -- enforced by UNIQUE(finding_id), never a fresh row per retry. */
export function insertOfferedContract(db: TclkDb, fields: { findingId: string; offerId: string; offerMessageId: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tclk_contracts (finding_id, tclk_offer_id, cached_status, offer_message_id, created_at, updated_at)
     VALUES (?, ?, 'proposed', ?, ?, ?)`,
  ).run(fields.findingId, fields.offerId, fields.offerMessageId, now, now);
}

/** Agent B, at accept time: fills in the accept side of the SAME row Agent A
 * created at offer time. Falls back to inserting a fresh row only if none
 * exists yet (defensive -- in this project's normal flow Agent A's offer step
 * always creates it first, since both workers share one local database). */
export function recordAccepted(db: TclkDb, fields: { findingId: string; contractId: string; offerId: string; acceptMessageId: string }): void {
  const existing = getContractByFindingId(db, fields.findingId);
  const now = new Date().toISOString();
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO tclk_contracts (finding_id, tclk_contract_id, tclk_offer_id, cached_status, accept_message_id, created_at, updated_at)
       VALUES (?, ?, ?, 'accepted', ?, ?, ?)`,
    ).run(fields.findingId, fields.contractId, fields.offerId, fields.acceptMessageId, now, now);
    return;
  }
  db.prepare(
    `UPDATE tclk_contracts SET tclk_contract_id = ?, cached_status = 'accepted', accept_message_id = ?, updated_at = ? WHERE finding_id = ?`,
  ).run(fields.contractId, fields.acceptMessageId, now, fields.findingId);
}

export function updateContractCache(
  db: TclkDb,
  findingId: string,
  fields: Partial<{
    tclkContractId: string;
    cachedStatus: string;
    acceptMessageId: string;
    lockMessageId: string;
    verificationMessageId: string;
    revealMessageId: string;
    receiptMessageId: string;
  }>,
): void {
  const columns: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.tclkContractId !== undefined) columns.tclk_contract_id = fields.tclkContractId;
  if (fields.cachedStatus !== undefined) columns.cached_status = fields.cachedStatus;
  if (fields.acceptMessageId !== undefined) columns.accept_message_id = fields.acceptMessageId;
  if (fields.lockMessageId !== undefined) columns.lock_message_id = fields.lockMessageId;
  if (fields.verificationMessageId !== undefined) columns.verification_message_id = fields.verificationMessageId;
  if (fields.revealMessageId !== undefined) columns.reveal_message_id = fields.revealMessageId;
  if (fields.receiptMessageId !== undefined) columns.receipt_message_id = fields.receiptMessageId;

  const names = Object.keys(columns);
  const setClause = names.map((n) => `${n} = ?`).join(", ");
  db.prepare(`UPDATE tclk_contracts SET ${setClause} WHERE finding_id = ?`).run(...names.map((n) => columns[n]), findingId);
}
