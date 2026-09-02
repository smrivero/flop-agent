/**
 * The Verifier reads and writes the SAME SQLite file Radar uses
 * (`openDatabase` from `../mentions/database.js`, untouched) -- that's what
 * lets `getFindingByFindingId` and the pending-selection query below work
 * with a plain SQL read, no IPC, no second database. This file only adds one
 * new table (`verifications`) via its own migration, run after Radar's own;
 * `mentions`/`query_rotation`/`run_log`/`radar_status` are never touched.
 */

import { openDatabase as openMentionsDatabase, type MentionsDb } from "../mentions/database.js";
import type { MentionRow } from "../mentions/types.js";
import type { VerificationResult, VerificationRow, VerificationStatus } from "./types.js";

export type VerifierDb = MentionsDb;

export function openDatabase(path: string): VerifierDb {
  const db = openMentionsDatabase(path);
  migrateVerifications(db);
  return db;
}

function migrateVerifications(db: VerifierDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id TEXT NOT NULL UNIQUE,
        result TEXT,
        reason TEXT,
        verifier_did TEXT,
        original_content_hash TEXT,
        verification_content_hash TEXT,
        verified_at TEXT,
        technocore_room TEXT,
        technocore_message_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
    );
  `);
}

/**
 * Findings ready for the Verifier: `published` in `mentions`, and either never
 * verified at all, or stuck in a non-terminal verification state (`pending`,
 * `verification_failed`, `publish_failed`) -- so a retry picks the exact same
 * row back up. Already-`verified`/`rejected`/`unverifiable` findings are
 * excluded, which is what makes re-running this safe without `--force`.
 * Oldest published first.
 */
export function getPendingFindingsToVerify(db: VerifierDb, limit: number): MentionRow[] {
  return db
    .prepare(
      `SELECT m.* FROM mentions m
       LEFT JOIN verifications v ON v.finding_id = m.finding_id
       WHERE m.status = 'published'
         AND (v.finding_id IS NULL OR v.status IN ('pending', 'verification_failed', 'publish_failed'))
       ORDER BY m.discovered_at ASC, m.id ASC
       LIMIT ?`,
    )
    .all(limit) as MentionRow[];
}

export function getVerification(db: VerifierDb, findingId: string): VerificationRow | undefined {
  return db.prepare(`SELECT * FROM verifications WHERE finding_id = ?`).get(findingId) as VerificationRow | undefined;
}

/** Ensures a row exists for this finding (status='pending' if new), and
 * returns it -- idempotent, so calling this again on a retry just returns the
 * existing row untouched. */
export function ensurePendingVerification(db: VerifierDb, findingId: string): VerificationRow {
  const existing = getVerification(db, findingId);
  if (existing) return existing;

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO verifications (finding_id, status, created_at) VALUES (?, 'pending', ?)`).run(findingId, now);
  return getVerification(db, findingId)!;
}

/**
 * Upsert, not a plain UPDATE: production code (run.ts) always calls
 * ensurePendingVerification first, so a matching row already exists in
 * practice -- but the mark* functions below must be correct on their own too
 * (a bare UPDATE against a nonexistent finding_id silently affects zero rows
 * and no error), so this creates the row if needed rather than depending on
 * call order. `created_at` is only ever set on first insert, via the INSERT
 * column list -- ON CONFLICT never touches it, so an existing row's
 * created_at is preserved.
 */
function setVerificationStatus(db: VerifierDb, findingId: string, status: VerificationStatus, fields: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  const columns: Record<string, unknown> = { status, updated_at: now, ...fields };
  const names = Object.keys(columns);
  const insertColumns = ["finding_id", "created_at", ...names];
  const insertValues = [findingId, now, ...names.map((n) => columns[n])];
  const updateSet = names.map((n) => `${n} = excluded.${n}`).join(", ");
  db.prepare(
    `INSERT INTO verifications (${insertColumns.join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})
     ON CONFLICT(finding_id) DO UPDATE SET ${updateSet}`,
  ).run(...insertValues);
}

/** Analysis succeeded and the result is stored, but the Technocore write
 * hasn't happened (or failed) yet -- kept separate from markPublishFailed so a
 * retry can tell "never analyzed" apart from "analyzed, just needs a repost".
 * `verificationContentHash` is null for UNVERIFIABLE: a blocked fetch never
 * produced content to hash. */
export function markAnalyzed(
  db: VerifierDb,
  findingId: string,
  result: VerificationResult,
  reason: string,
  verifierDid: string,
  originalContentHash: string | null,
  verificationContentHash: string | null,
): void {
  setVerificationStatus(db, findingId, "publish_failed", {
    result,
    reason,
    verifier_did: verifierDid,
    original_content_hash: originalContentHash,
    verification_content_hash: verificationContentHash,
    error: null,
  });
}

function statusForResult(result: VerificationResult): "verified" | "rejected" | "unverifiable" {
  if (result === "VERIFIED") return "verified";
  if (result === "REJECTED") return "rejected";
  return "unverifiable";
}

export function markPublished(db: VerifierDb, findingId: string, result: VerificationResult, room: string, messageId: string): void {
  setVerificationStatus(db, findingId, statusForResult(result), {
    technocore_room: room,
    technocore_message_id: messageId,
    verified_at: new Date().toISOString(),
    error: null,
  });
}

export function markPublishFailed(db: VerifierDb, findingId: string, error: string): void {
  setVerificationStatus(db, findingId, "publish_failed", { error });
}

/** A fetch or OpenAI failure -- never a REJECTED verdict. Retryable later;
 * next run starts the analysis over from scratch (no cached result exists
 * yet, unlike markPublishFailed's retry-just-the-publish path). */
export function markVerificationFailed(db: VerifierDb, findingId: string, error: string): void {
  setVerificationStatus(db, findingId, "verification_failed", { error });
}

/** `--force` re-verification: discard whatever was there before (fresh row
 * state), so the run behaves exactly like the first time this finding was
 * ever picked up. */
export function resetVerification(db: VerifierDb, findingId: string): void {
  db.prepare(
    `UPDATE verifications SET status = 'pending', result = NULL, reason = NULL, verifier_did = NULL,
       original_content_hash = NULL, verification_content_hash = NULL, verified_at = NULL,
       technocore_room = NULL, technocore_message_id = NULL, error = NULL, updated_at = ?
     WHERE finding_id = ?`,
  ).run(new Date().toISOString(), findingId);
}
