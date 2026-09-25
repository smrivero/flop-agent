/**
 * Key directory checks (no key is generated, read or printed here -- only file metadata).
 *
 *   data/close-call/keys/          mode 700, owned by the service user
 *   data/close-call/keys/CCnnn.json  mode 600, owned by the service user
 *   data/close-call/backups/keys-*.tar.gz.age|.gpg   an ENCRYPTED backup newer than the newest key file
 *
 * `closecall:keys --validate` prints this report. Plaintext archives of the key directory are
 * reported as a problem, never as a backup.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface KeyDirReport {
  dir: string;
  exists: boolean;
  dirMode: string | null;
  dirOk: boolean;
  files: { name: string; mode: string; ok: boolean; ownerOk: boolean }[];
  backup: { latest: string | null; encrypted: boolean; newerThanKeys: boolean; plaintextFound: string[] };
  problems: string[];
}

const mode = (m: number) => (m & 0o777).toString(8).padStart(3, "0");

export function validateKeyDir(dir: string, backupDir: string, uid = typeof process.getuid === "function" ? process.getuid() : null): KeyDirReport {
  const problems: string[] = [];
  const r: KeyDirReport = { dir, exists: existsSync(dir), dirMode: null, dirOk: false, files: [], backup: { latest: null, encrypted: false, newerThanKeys: false, plaintextFound: [] }, problems };
  if (!r.exists) {
    problems.push(`${dir} does not exist yet (no keys generated)`);
    return r;
  }
  const st = statSync(dir);
  r.dirMode = mode(st.mode);
  r.dirOk = (st.mode & 0o077) === 0 && (uid === null || st.uid === uid);
  if (!r.dirOk) problems.push(`${dir}: mode ${r.dirMode} / owner ${st.uid} (must be 700, service user)`);
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const f = statSync(join(dir, name));
    if (!f.isFile()) continue;
    newest = Math.max(newest, f.mtimeMs);
    const ok = (f.mode & 0o077) === 0;
    const ownerOk = uid === null || f.uid === uid;
    r.files.push({ name, mode: mode(f.mode), ok, ownerOk });
    if (!ok) problems.push(`${name}: mode ${mode(f.mode)} (must be 600)`);
    if (!ownerOk) problems.push(`${name}: not owned by the service user`);
    if (!/^CC\d{3}\.json$/.test(name)) problems.push(`${name}: unexpected file in the key directory`);
  }
  if (existsSync(backupDir)) {
    const all = readdirSync(backupDir).filter((f) => f.startsWith("keys-"));
    r.backup.plaintextFound = all.filter((f) => !/\.(age|gpg)$/.test(f));
    const enc = all.filter((f) => /\.(age|gpg)$/.test(f)).map((f) => ({ f, t: statSync(join(backupDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (enc[0]) {
      r.backup.latest = enc[0].f;
      r.backup.encrypted = true;
      r.backup.newerThanKeys = enc[0].t >= newest;
    }
  }
  if (r.files.length && !r.backup.encrypted) problems.push("no encrypted key backup found (owner keys are needed to claim a prize)");
  if (r.files.length && r.backup.encrypted && !r.backup.newerThanKeys) problems.push("the latest encrypted key backup is older than the newest key file");
  for (const p of r.backup.plaintextFound) problems.push(`${p}: plaintext key archive in the backup directory -- delete it`);
  return r;
}
