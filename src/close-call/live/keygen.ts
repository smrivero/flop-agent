/**
 * LIVE ONLY. Real key generation, signer loading and the Mac-side restore verification.
 *
 * Key files: <keysDir>/CCnnn.json = {"did","seedHex"} (the project's identity.json schema), created
 * with O_EXCL (never overwritten), mode 0600, in a 0700 directory, fsynced, then re-loaded and
 * self-tested (sign + verify) before the key is recorded in the LIVE database (did + path only).
 *
 * Generation is refused unless the backup gate passes (backup-gate.ts): an age-encrypted backup
 * of exactly the current key files was decrypted and checked on the operator's Mac. The same gate
 * then blocks every live write until the NEW keys are in a verified backup too.
 *
 * No function here logs, returns or throws a seed.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { didFromPublicKey, generateIdentitySeed, verifyEd25519 } from "../../identity.js";
import { backupGate, CANARY_FILE, keyFileHashes, KEY_FILE_RE, verifyCode, type FileHash } from "../backup-gate.js";
import { keysByRole, listKeys, roleKeyId, type KeyRole } from "../keys.js";
import { ccLog } from "../logger.js";
import type { Signer } from "../protocol-writes.js";
import { now, type CcDb } from "../store.js";
import { KeyFileError, loadFileSigner } from "./signer.js";

export class KeygenRefused extends Error {}

/** Sign a fixed probe string and verify it against the DID: proves the file's seed and did agree. */
function selfTest(s: Signer): void {
  const msg = `close-call self-test|${s.did}`;
  if (!verifyEd25519(s.did, s.sign(msg), msg)) throw new KeyFileError(`${s.did}: self-test signature does not verify`);
}

export function loadSigner(path: string): Signer {
  const s = loadFileSigner(path, didFromPublicKey);
  selfTest(s);
  return s;
}

/** Signers for every real key recorded in the live DB. Refuses on any missing / loose / mismatching file. */
export function loadSigners(db: CcDb): Map<string, Signer> {
  const out = new Map<string, Signer>();
  for (const k of listKeys(db).filter((x) => x.fake === 0)) {
    if (!k.key_path) throw new KeyFileError(`${k.id}: no key_path recorded`);
    const s = loadSigner(k.key_path);
    if (s.did !== k.did) throw new KeyFileError(`${k.id}: key file did differs from the recorded did`);
    out.set(k.id, s);
  }
  return out;
}

/**
 * Generate keys up to `total` (CC001..CC<total>), only the ones that do not exist yet.
 * Progressive plan: total=2 first, total=100 after the 2-key stage is validated.
 */
export function generateKeys(db: CcDb, p: { keysDir: string; backupDir: string; recipient: string | null; total: number; role?: KeyRole }): { created: string[]; existing: number } {
  const role: KeyRole = p.role ?? "strategy";
  const max = role === "admin" ? 1 : role === "staging" ? 2 : 100;
  if (!Number.isInteger(p.total) || p.total < 1 || p.total > max) throw new KeygenRefused(`${role}: total must be 1..${max}`);
  if ((db.prepare("SELECT COUNT(*) n FROM keys WHERE fake = 1").get() as { n: number }).n > 0) {
    throw new KeygenRefused("this database holds paper (fake) keys: real keys go in the live DB only (CLOSECALL_LIVE_DB_PATH)");
  }
  const gate = backupGate(db, p);
  if (!gate.ok) throw new KeygenRefused(`backup gate: ${gate.problems.join("; ")}`);
  mkdirSync(p.keysDir, { recursive: true, mode: 0o700 });
  if ((statSync(p.keysDir).mode & 0o077) !== 0) throw new KeygenRefused(`${p.keysDir} must be mode 700`);
  const all = listKeys(db).filter((k) => k.fake === 0);
  const onDisk = readdirSync(p.keysDir).filter((f) => KEY_FILE_RE.test(f));
  if (onDisk.length !== all.length) throw new KeygenRefused(`${onDisk.length} key files on disk but ${all.length} keys in the live DB: resolve by hand first`);
  const existing = keysByRole(db, role);
  const created: string[] = [];
  const ins = db.prepare("INSERT INTO keys (id, did, key_path, fake, status, role, updated_at) VALUES (?, ?, ?, 0, 'GENERATED', ?, ?)");
  for (let i = existing.length + 1; i <= p.total; i++) {
    const id = roleKeyId(role, i);
    const path = join(p.keysDir, `${id}.json`);
    if (existsSync(path)) throw new KeygenRefused(`${path} already exists: refusing to overwrite a key`);
    const { did, seedHex } = generateIdentitySeed();
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ did, seedHex }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const s = loadSigner(path);
    if (s.did !== did) throw new KeyFileError(`${id}: written key does not reload to the same did`);
    ins.run(id, did, path, role, now());
    created.push(id);
    ccLog("KEYS", { key: id, did }, "real key generated (0600); it is NOT in any verified backup yet");
  }
  const dfd = openSync(p.keysDir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  return { created, existing: all.length };
}

export interface RestoreReport { keys: { file: string; did: string }[]; files: FileHash[]; canaryPresent: boolean; code: string | null; problems: string[] }

/**
 * Mac side: check a DECRYPTED backup's key directory. Every CCnnn.json must reload and self-test.
 * Prints the verify code the VPS needs (canary + files digest). The canary is not a secret
 * (it only proves decryption); the seeds are never read out of this function.
 */
export function verifyRestoredKeyDir(dir: string): RestoreReport {
  const problems: string[] = [];
  const keys: RestoreReport["keys"] = [];
  for (const f of readdirSync(dir).filter((x) => KEY_FILE_RE.test(x)).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { did?: string };
      const s = loadFileSigner(join(dir, f), didFromPublicKey);
      selfTest(s);
      if (raw.did !== s.did) throw new Error("did mismatch");
      keys.push({ file: f, did: s.did });
    } catch (e) {
      // Never echo a parser message: Node's JSON errors quote the input, i.e. part of a seed.
      problems.push(`${f}: ${e instanceof KeyFileError ? e.message : "unreadable or not a valid key file"}`);
    }
  }
  const canaryPath = join(dir, CANARY_FILE);
  const canaryPresent = existsSync(canaryPath);
  if (!canaryPresent) problems.push(`${CANARY_FILE} missing from the archive`);
  const files = keyFileHashes(dir);
  return { keys, files, canaryPresent, code: canaryPresent && !problems.length ? verifyCode(readFileSync(canaryPath, "utf8"), files) : null, problems };
}
