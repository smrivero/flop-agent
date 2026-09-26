/**
 * Encrypted key backup gate. No real key may be generated, and no live write may happen, unless an
 * age-encrypted backup of the key directory exists AND the operator has proven, on their Mac, that it
 * decrypts and holds exactly the current key files.
 *
 * The VPS knows only the age RECIPIENT (public). It cannot decrypt, so the proof works like this:
 *
 *   1. `keys --backup-canary`      writes keys/BACKUP-CANARY (random, 0600) once. Its sha256 is public.
 *   2. closecall-backup.sh          tar(keys/, env) | age -r <recipient> > backups/secrets-<ts>.tar.age,
 *                                   then `keys --record-backup` writes secrets-<ts>.manifest.json:
 *                                   archive sha256, every key file's name + sha256, the canary's sha256.
 *   3. Mac: closecall-restore-check.sh (LOCAL=1, AGE_IDENTITY=...) decrypts into a private temp dir,
 *      checks every key file (seed -> did), and prints a VERIFY CODE = <canary>.<files digest>.
 *      Only someone who decrypted the archive can know the canary.
 *   4. VPS: `keys --backup-verify --archive <name> --code <code>` checks the code against the manifest
 *      and records the verification in the live DB.
 *
 * The gate passes only while: a recipient is configured, the verified archive is still on disk with
 * the same sha256, the canary is unchanged, and the key files on disk are EXACTLY the verified set.
 * Generating keys changes the set, so the next write needs a new backup + verification first.
 *
 * Nothing here reads a key's contents except to hash it; no key material is ever printed or stored.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { getMeta, setMeta, type CcDb } from "./store.js";

export const CANARY_FILE = "BACKUP-CANARY";
export const KEY_FILE_RE = /^CC(\d{3}|-TEST-\d{3}|-ADMIN)\.json$/;

export interface FileHash { name: string; sha256: string }
export interface BackupManifest {
  archive: string;
  archive_sha256: string;
  created_at: string;
  recipient: string;
  files: FileHash[];
  files_digest: string;
  canary_sha256: string;
}
export interface BackupVerification { archive: string; archive_sha256: string; files: FileHash[]; files_digest: string; canary_sha256: string; verified_at: string }

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function keyFileHashes(keysDir: string): FileHash[] {
  if (!existsSync(keysDir)) return [];
  return readdirSync(keysDir).filter((f) => KEY_FILE_RE.test(f)).sort().map((name) => ({ name, sha256: sha(readFileSync(join(keysDir, name))) }));
}

/** Order-independent digest of the key file set: sha256 of "name sha256\n" lines sorted by name. */
export function filesDigest(files: FileHash[]): string {
  return sha([...files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `${f.name} ${f.sha256}\n`).join(""));
}

export function canarySha(keysDir: string): string | null {
  const p = join(keysDir, CANARY_FILE);
  return existsSync(p) ? sha(readFileSync(p, "utf8").trim()) : null;
}

/** Create the canary once (never replaced: replacing it would silently invalidate every verified backup). */
export function ensureCanary(keysDir: string): { created: boolean; sha256: string } {
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const p = join(keysDir, CANARY_FILE);
  if (existsSync(p)) return { created: false, sha256: canarySha(keysDir)! };
  const fd = openSync(p, "wx", 0o600);
  writeSync(fd, randomBytes(32).toString("hex") + "\n");
  closeSync(fd);
  return { created: true, sha256: canarySha(keysDir)! };
}

/** Called by closecall-backup.sh right after it encrypted `archivePath`. Refuses if a key changed during the backup. */
export function recordBackup(keysDir: string, archivePath: string, recipient: string, startedMs: number): BackupManifest {
  const files = keyFileHashes(keysDir);
  for (const f of files) {
    if (statSync(join(keysDir, f.name)).mtimeMs > startedMs) throw new Error(`${f.name} changed while the backup was running: run the backup again`);
  }
  const canary = canarySha(keysDir);
  if (!canary) throw new Error(`no ${CANARY_FILE} in ${keysDir}: run keys --backup-canary first`);
  const m: BackupManifest = {
    archive: basename(archivePath), archive_sha256: sha(readFileSync(archivePath)), created_at: new Date().toISOString(),
    recipient, files, files_digest: filesDigest(files), canary_sha256: canary,
  };
  writeFileSync(archivePath.replace(/\.tar\.age$/, ".manifest.json"), JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
  return m;
}

export function readManifest(backupDir: string, archive: string): BackupManifest {
  if (!/^secrets-[0-9TZ]+\.tar\.age$/.test(archive)) throw new Error(`not a secrets archive name: ${archive}`);
  const p = join(backupDir, archive.replace(/\.tar\.age$/, ".manifest.json"));
  if (!existsSync(p)) throw new Error(`no manifest for ${archive}`);
  return JSON.parse(readFileSync(p, "utf8")) as BackupManifest;
}

/** The code the Mac-side restore check prints: `<canary hex>.<files digest>`. */
export function verifyCode(canary: string, files: FileHash[]): string {
  return `${canary.trim()}.${filesDigest(files)}`;
}

/** VPS side: accept a verification code for an archive. Records it in the live DB. */
export function recordVerification(db: CcDb, backupDir: string, archive: string, code: string): BackupVerification {
  const m = readManifest(backupDir, archive);
  const [canary, digest] = code.trim().split(".");
  if (!canary || !digest || sha(canary) !== m.canary_sha256) throw new Error("verify code does not match this archive's canary: the archive was not decrypted, or it is another archive");
  if (digest !== m.files_digest) throw new Error("verify code lists a different key set than this archive's manifest");
  const p = join(backupDir, archive);
  if (!existsSync(p) || sha(readFileSync(p)) !== m.archive_sha256) throw new Error(`${archive} is missing or changed since it was recorded`);
  const v: BackupVerification = { archive, archive_sha256: m.archive_sha256, files: m.files, files_digest: m.files_digest, canary_sha256: m.canary_sha256, verified_at: new Date().toISOString() };
  setMeta(db, "backup_verified", JSON.stringify(v));
  return v;
}

export interface GateResult { ok: boolean; problems: string[]; verified: BackupVerification | null; currentFiles: number }

/**
 * The gate for key generation and for every live write. `recipient` comes from the config
 * (CLOSECALL_BACKUP_AGE_RECIPIENT).
 */
export function backupGate(db: CcDb, p: { keysDir: string; backupDir: string; recipient: string | null }): GateResult {
  const problems: string[] = [];
  if (!p.recipient) problems.push("CLOSECALL_BACKUP_AGE_RECIPIENT is not set: no encrypted key backup is possible");
  const raw = getMeta(db, "backup_verified");
  const v = raw ? (JSON.parse(raw) as BackupVerification) : null;
  const current = keyFileHashes(p.keysDir);
  if (!v) {
    problems.push("no verified backup: run closecall-backup.sh, check it on the Mac (restore-check), then keys --backup-verify");
    return { ok: false, problems, verified: null, currentFiles: current.length };
  }
  const arch = join(p.backupDir, v.archive);
  if (!existsSync(arch)) problems.push(`verified archive ${v.archive} is no longer in ${p.backupDir}`);
  else if (sha(readFileSync(arch)) !== v.archive_sha256) problems.push(`verified archive ${v.archive} changed on disk`);
  const canary = canarySha(p.keysDir);
  if (canary !== v.canary_sha256) problems.push(`${CANARY_FILE} is missing or differs from the verified backup's`);
  if (filesDigest(current) !== v.files_digest) {
    const known = new Set(v.files.map((f) => `${f.name} ${f.sha256}`));
    const notBacked = current.filter((f) => !known.has(`${f.name} ${f.sha256}`)).map((f) => f.name);
    const gone = v.files.filter((f) => !current.some((c) => c.name === f.name && c.sha256 === f.sha256)).map((f) => f.name);
    problems.push(`key files differ from the verified backup (not backed up: ${notBacked.join(" ") || "-"}; missing now: ${gone.join(" ") || "-"}): back up and verify again`);
  }
  return { ok: problems.length === 0, problems, verified: v, currentFiles: current.length };
}
