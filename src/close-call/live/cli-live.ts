/**
 * LIVE ONLY. The live-side CLI, separate from the paper CLI (cli.ts never imports this file).
 *
 *   status                               live DB: keys, room, backup gate, pending writes, halts (no network)
 *   keygen --total N --i-understand-these-are-real-keys
 *                                        generate CC001..CC<N> (only missing ones). Refused unless the backup gate passes.
 *   restore-verify <decrypted keys dir>  (on the Mac) check a decrypted backup and print its VERIFY CODE
 *   bootstrap --dry-run [--stages 2,100] [--faults] [--miss-first] [--policy P] [--json]
 *                                        the full bootstrap against an in-memory server + simulated referee
 *   bootstrap                            the real bootstrap: NOT CONNECTED in this build (refuses, exit 3)
 *
 * The real bootstrap additionally needs CLOSECALL_MODE=live + the exact CLOSECALL_LIVE_ENABLED ack
 * (config.ts), CLOSECALL_ROOM, the backup gate, its own lock, and LIVE_WRITER_CONNECTED = true
 * -- a one-line change that must go through review. Paper mode never loads this file.
 */

import { lastClosedSweep, loadContest } from "../contest.js";
import { CloseCallConfigError, loadCloseCallConfig } from "../config.js";
import { backupGate } from "../backup-gate.js";
import { Bootstrap } from "../bootstrap.js";
import { WriteJournal } from "../journal.js";
import { keyStatusCounts } from "../keys.js";
import { fetchLimits } from "../limits.js";
import { acquireLock, LockHeldError } from "../lock.js";
import { ccLog, setLogSink, setQuiet } from "../logger.js";
import { RefereeObserver } from "../observer.js";
import { getRoom } from "../room.js";
import { halt, haltSummary } from "../safety.js";
import { openCloseCallDb } from "../store.js";
import { simulateBootstrap } from "../testing/bootstrap-sim.js";
import { HttpTransport } from "./http-transport.js";
import { generateKeys, KeygenRefused, loadSigners, verifyRestoredKeyDir } from "./keygen.js";

/** Flipping this is the act of connecting the live writer. Keep false until the reviewed go-live change. */
export const LIVE_WRITER_CONNECTED = false;

const out = (v: unknown) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const has = (f: string) => argv.includes(f);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const cfg = loadCloseCallConfig();
  const contest = loadContest(cfg.vendorRoot);

  if (cmd === "restore-verify") {
    const dir = argv[1];
    if (!dir) { process.stderr.write("usage: cli-live restore-verify <decrypted keys dir>\n"); return 2; }
    const r = verifyRestoredKeyDir(dir);
    out({ keys: r.keys.length, dids: r.keys.map((k) => `${k.file} ${k.did}`), problems: r.problems });
    if (r.code) out(`VERIFY CODE: ${r.code}`);
    return r.problems.length ? 1 : 0;
  }

  if (cmd === "bootstrap" && has("--dry-run")) {
    setQuiet(!has("--verbose"));
    const stages = (arg("--stages") ?? "2,100").split(",").map(Number);
    const r = await simulateBootstrap(contest, {
      stages, startSweep: Math.max(2, lastClosedSweep(contest, Date.now())), faults: has("--faults"), missFirstOwner: has("--miss-first"),
      policy: (arg("--policy") as "STRICT" | "PROTOCOL" | "PROBE" | undefined) ?? cfg.confirmationPolicy,
    });
    if (has("--json")) { out(r); return r.ok ? 0 : 1; }
    out("BOOTSTRAP DRY-RUN -- in-memory server, simulated referee, throwaway keys. NOTHING was sent to Technocore.");
    for (const s of r.steps) out(`  ${s.phase.padEnd(16)} ${s.action.padEnd(8)} writes=${String(s.writes).padEnd(3)} ${s.detail}${s.blockers?.length ? `  [${s.blockers[0]}${s.blockers.length > 1 ? ` +${s.blockers.length - 1}` : ""}]` : ""}`);
    out("stages:");
    for (const s of r.stages) out(`  ${s.keys} keys: ${s.writes} POSTs, ${s.steps} steps, ~${s.minutes} simulated min`);
    out("checks:");
    for (const c of r.checks) out(`  ${c.ok ? "OK  " : "FAIL"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    out(`result: ${r.ok ? "OK" : "FAILED"}  final=${JSON.stringify(r.final)}`);
    return r.ok ? 0 : 1;
  }

  const db = openCloseCallDb(cfg.liveDbPath);
  if (cmd === "status") {
    out({ live_db: cfg.liveDbPath, writer_connected: LIVE_WRITER_CONNECTED, mode: cfg.mode, policy: cfg.confirmationPolicy, room: cfg.room,
      room_status: cfg.room ? getRoom(db, cfg.room).status : null, keys: keyStatusCounts(db),
      backup_gate: backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient }),
      pending_writes: (db.prepare("SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')").get() as { n: number }).n,
      halted: haltSummary(db) });
    return 0;
  }

  if (cmd === "keygen") {
    const total = Number(arg("--total"));
    if (!has("--i-understand-these-are-real-keys")) { process.stderr.write("keygen creates REAL keys: pass --total N --i-understand-these-are-real-keys\n"); return 2; }
    try {
      const r = generateKeys(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient, total });
      out({ created: r.created, existing: r.existing, next: "run closecall-backup.sh, verify it on the Mac, then keys --backup-verify: live writes stay blocked until then" });
      return 0;
    } catch (e) {
      if (e instanceof KeygenRefused) { process.stderr.write(`[CLOSECALL][KEYS] refused: ${e.message}\n`); return 3; }
      throw e;
    }
  }

  if (cmd === "bootstrap") {
    if (!LIVE_WRITER_CONNECTED) {
      process.stderr.write("[CLOSECALL][HALT] the live writer is not connected in this build: refusing. NO WRITE. (use --dry-run)\n");
      return 3;
    }
    // ---- everything below runs only after the reviewed go-live change ----
    if (cfg.mode !== "live") { process.stderr.write("bootstrap needs CLOSECALL_MODE=live and the exact CLOSECALL_LIVE_ENABLED ack\n"); return 3; }
    if (!cfg.room) { process.stderr.write("CLOSECALL_ROOM is not set\n"); return 2; }
    const lock = await acquireLock(cfg.liveDbPath + ".lock", "close-call live bootstrap");
    setLogSink(cfg.logDir);
    try {
      const limits = await fetchLimits(cfg.technocoreBaseUrl);
      const perWriteMs = Math.ceil(60_000 / Math.max(1, Math.floor(limits.writesPerMinPerIp * cfg.writeBudgetFraction)));
      const signers = loadSigners(db);
      const transport = new HttpTransport(cfg.technocoreBaseUrl);
      const observer = new RefereeObserver(db, cfg.technocoreBaseUrl, cfg.rawLogDir);
      const journal = new WriteJournal(db, signers, transport, { onAmbiguous: (row, why) => halt(db, "ambiguous_operation", `${row.op_key}: ${why}`) });
      await journal.recover();
      const b = new Bootstrap({
        db, contest, journal, transport, signers, policy: cfg.confirmationPolicy, room: cfg.room, clock: Date.now,
        refreshReferee: async () => { await observer.pollOnce(); },
        gate: () => backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient }),
        pace: async () => { await sleep(perWriteMs); }, refreshDays: cfg.roomRefreshDays,
      });
      const r = await b.step();
      ccLog("BOOTSTRAP", { phase: r.phase, action: r.action, writes: r.writes }, r.detail);
      out(r);
      return r.action === "halted" || r.action === "blocked" ? 1 : 0;
    } finally {
      lock.release();
    }
  }

  process.stderr.write("usage: cli-live <status | keygen --total N --i-understand-these-are-real-keys | restore-verify <dir> | bootstrap --dry-run [...]>\n");
  return 2;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
  if (e instanceof CloseCallConfigError) { process.stderr.write(`[CLOSECALL][CONFIG] ${e.message}\n`); process.exit(2); }
  if (e instanceof LockHeldError) { process.stderr.write(`[CLOSECALL][LOCK] ${e.message}\n`); process.exit(4); }
  process.stderr.write(`[CLOSECALL][ERROR] ${(e as Error).message}\n`);
  process.exit(1);
});
