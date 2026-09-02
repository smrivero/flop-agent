/**
 * Custody for preimages Agent B mints at ACCEPT time and must not lose before
 * REVEAL. tclk itself is explicit that the caller owns this ("the component
 * that calls the protocol is responsible for custodying the secret" -- the MCP
 * server, for comparison, never stores one server-side either).
 *
 * Deliberately NOT a column in the shared mentions.sqlite3 (that file has no
 * particular access-control story and is read by two pipelines) -- a separate
 * file, chmod 0600 on creation, living next to the identity files this project
 * already treats as sensitive (.technocore/, gitignored). Only Agent B's
 * worker ever opens this file.
 *
 * SECURITY: nothing in this module logs a preimage. Callers must not either --
 * see verifierWorker.ts, which never prints `preimage`/`secret` in any log line.
 */

import Database from "better-sqlite3";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type SecretDb = Database.Database;

export function openSecretStore(path: string): SecretDb {
  const isNew = !existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS preimages (
        contract_id TEXT PRIMARY KEY,
        preimage TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
  `);
  if (isNew) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort on platforms without POSIX permission bits (still gitignored).
    }
  }
  return db;
}

/** Store a freshly-minted preimage. Throws on a duplicate contract_id rather
 * than silently overwriting -- a second mint for the same contract would mean
 * two different secrets exist for one statement, which is a bug, not a retry. */
export function storePreimage(db: SecretDb, contractId: string, preimage: string): void {
  db.prepare(`INSERT INTO preimages (contract_id, preimage, created_at) VALUES (?, ?, ?)`).run(
    contractId,
    preimage,
    new Date().toISOString(),
  );
}

export function getPreimage(db: SecretDb, contractId: string): string | undefined {
  const row = db.prepare(`SELECT preimage FROM preimages WHERE contract_id = ?`).get(contractId) as { preimage: string } | undefined;
  return row?.preimage;
}
