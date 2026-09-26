/**
 * LIVE ONLY. The live-side CLI, separate from the paper CLI (cli.ts never imports this file).
 *
 *   status                               live DB: keys, room, backup gate, pending writes, halts (no network)
 *   unhalt --code <code>                 clear a GRAVE halt in the LIVE DB (the code is in `live status`)
 *   keygen --total N --i-understand-these-are-real-keys
 *                                        generate CC001..CC<N> (only missing ones). Refused unless the backup gate passes.
 *   restore-verify <decrypted keys dir>  (on the Mac) check a decrypted backup and print its VERIFY CODE
 *   bootstrap --dry-run [--stages 2,100] [--faults] [--miss-first] [--policy P] [--json]
 *                                        the full bootstrap against an in-memory server + simulated referee
 *   bootstrap [--loop]                   the real bootstrap (needs the writer ARMED: CLOSECALL_LIVE_WRITER=armed, no kill switch)
 *   disarm --reason "..."                kill switch: no write, no new decision; observer keeps running
 *   arm                                  remove the kill switch (refused unless live-check passes)
 *   check                                `live-check`: every live precondition, read only, nothing written or sent
 *   run                                  the live service (Strategy K through the LiveExecutor). Refuses unless check PASSes.
 *
 * The writer is connected in this build: the same code runs in tests and in live. It writes only when
 * CLOSECALL_MODE=live + the exact ack, CLOSECALL_LIVE_WRITER=armed, and no DISARM file (the kill switch)
 * -- all configuration, never a code change. Paper mode never loads this file.
 */

import { lastClosedSweep, loadContest, sweepTime } from "../contest.js";
import { CloseCallConfigError, loadCloseCallConfig } from "../config.js";
import { backupGate } from "../backup-gate.js";
import { Bootstrap, RoomKeeper } from "../bootstrap.js";
import { isolatedTradeFold } from "../fold.js";
import { WriteJournal } from "../journal.js";
import { keyStatusCounts } from "../keys.js";
import { fetchLimits } from "../limits.js";
import { acquireLock, LockHeldError } from "../lock.js";
import { ccLog, setLogSink, setQuiet } from "../logger.js";
import { RefereeObserver } from "../observer.js";
import { getRoom } from "../room.js";
import { disarm, halt, haltSummary, rearm, unhalt, writerState } from "../safety.js";
import { openCloseCallDb } from "../store.js";
import { openReadonly } from "../monitor.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simulateBootstrap } from "../testing/bootstrap-sim.js";
import { foldConfig } from "../paper.js";
import { banner, runLoop } from "../run.js";
import { LiveExecutor } from "./executor.js";
import { HttpTransport } from "./http-transport.js";
import { liveReadiness, renderReadiness } from "./readiness.js";
import { renderDrill, restoreDrill } from "./restore-drill.js";
import { generateKeys, KeygenRefused, loadSigners, verifyRestoredKeyDir } from "./keygen.js";


const out = (v: unknown) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const has = (f: string) => argv.includes(f);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const cfg = loadCloseCallConfig();
  const contest = loadContest(cfg.vendorRoot);

  if (cmd === "restore-drill") {
    // Run on a RESTORED live data dir (CLOSECALL_DATA_DIR / DB paths point at it); offline, read only.
    const r = restoreDrill(cfg, arg("--archive") ?? null);
    out(renderDrill(r));
    return r.pass ? 0 : 1;
  }

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

  const envFile = process.env.CLOSECALL_ENV_FILE ?? null;
  const stage = arg("--stage") === "bootstrap" ? "bootstrap" as const : "check" as const;
  if (cmd === "check") {
    // --stage bootstrap: what must hold BEFORE the first write (it does not require what the bootstrap creates)
    const r = await liveReadiness(cfg, contest, stage, { offline: has("--offline"), envFile });
    if (stage === "bootstrap") out("STAGE: bootstrap (pre-write gate)");
    out(renderReadiness(r));
    return r.pass ? 0 : 1;
  }

  if (cmd === "run") {
    const r = await liveReadiness(cfg, contest, "run", { envFile });
    process.stdout.write(banner("live") + "\n");
    if (!r.pass) {
      process.stderr.write(renderReadiness(r) + "\n[CLOSECALL][HALT] live readiness FAILED: refusing to start. NO WRITE.\n");
      return 3;
    }
    const lock = await acquireLock(cfg.lockPath, "close-call live run");
    setLogSink(cfg.logDir);
    const ldb = openCloseCallDb(cfg.liveDbPath, { checkIntegrity: true });
    // The full gate result (incl. network: nonce reconciliation, room, clock skew, latency) as of this start:
    // the monitor shows it instead of calling external APIs itself.
    ldb.prepare("INSERT INTO meta (key, value) VALUES ('last_readiness', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: new Date().toISOString(), pass: r.pass, rows: r.rows }));
    try {
      const signers = loadSigners(ldb, cfg.keysDir);
      const transport = new HttpTransport(cfg.technocoreBaseUrl);
      const canWrite = () => { const w = writerState(cfg); return w.armed ? null : w.reason; };
      const journal = new WriteJournal(ldb, signers, transport, { onAmbiguous: (row, why) => halt(ldb, "ambiguous_operation", `${row.op_key}: ${why}`), canWrite });
      const executor = new LiveExecutor(ldb, signers, journal, transport, cfg.room!, contest, cfg.postGuardMs);
      const keeper = new RoomKeeper({ db: ldb, journal, transport, room: cfg.room!, clock: Date.now, refreshDays: cfg.roomRefreshDays,
        lockMs: sweepTime(contest, contest.lockSweep) });
      // technocore limits change per deployment: snapshot /config at start and hourly (audit + pacing)
      let nextSnap = 0;
      const snapshot = async () => {
        if (Date.now() < nextSnap) return;
        nextSnap = Date.now() + 3_600_000;
        const lim = await fetchLimits(cfg.technocoreBaseUrl).catch(() => null);
        if (lim) ldb.prepare("INSERT INTO config_snapshots (source, json, at) VALUES (?, ?, ?)").run(lim.source, JSON.stringify(lim), new Date().toISOString());
      };
      // Startup order: readiness (keys, room on server, nonce reconciliation, backup, clock) passed above ->
      // bootstrap-era writes reconciled -> runLoop: observer + reconcile, fold replay, live_trades recovery,
      // then decisions (none while a halt such as an UNKNOWN trade is active).
      await journal.recover();
      ccLog("MODE", { mode: "live", db: cfg.liveDbPath, room: cfg.room, keys: signers.size, policy: cfg.confirmationPolicy }, "LIVE MODE: Strategy K intents are signed and posted");
      await runLoop(ldb, cfg, contest, { paper: false, executor, canTrade: canWrite, maintenance: async () => { await snapshot(); return keeper.tick(); }, maxMinutes: arg("--minutes") ? Number(arg("--minutes")) : undefined });
      return 0;
    } finally {
      ldb.close();
      lock.release();
    }
  }

  if (cmd === "disarm") {
    disarm(cfg.dataDir, arg("--reason") ?? "manual");
    out(`DISARMED: ${writerState(cfg).reason}. No write and no new decision from now on; the observer keeps running.`);
    return 0;
  }
  if (cmd === "arm") {
    const probe = { ...cfg, liveWriter: "armed" as const };
    if (!rearm(cfg.dataDir)) { out(`no kill switch present; writer: ${writerState(cfg).reason}`); return 0; }
    const r = await liveReadiness(cfg, contest, stage, { envFile });
    if (!r.pass) { disarm(cfg.dataDir, `re-armed refused: live-check (${stage}) FAIL`); out(renderReadiness(r)); out("ARM REFUSED: kill switch put back."); return 3; }
    out(`ARMED: ${writerState(probe).reason}`);
    return 0;
  }

  if (cmd === "final-report" || cmd === "audit-export") {
    // Read only. final-report: S, our standings (official fold), our key DIDs + roles, the referee's final
    // posts -- public data only; the owner keys themselves stay in the encrypted backup for the claim.
    const { db: rdb } = openReadonly(cfg.liveDbPath);
    if (!rdb) { process.stderr.write("live DB unavailable\n"); return 1; }
    try {
      const meta = (k: string) => (rdb.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
      if (cmd === "final-report") {
        out({ contest: contest.contestId, final_S: JSON.parse(meta("final_S") ?? "null"), standings: JSON.parse(meta("final_standings") ?? "null"),
          keys: rdb.prepare("SELECT id, did, role, status, minted_sweep FROM keys WHERE fake = 0 ORDER BY id").all(),
          referee_final_posts: rdb.prepare("SELECT room, seq, ts, text FROM raw_posts WHERE room IN ('d-close1-price','d-close1-pnl') AND (text LIKE '%\"t\":\"final\"%' OR seq = (SELECT MAX(seq) FROM raw_posts r2 WHERE r2.room = raw_posts.room))").all(),
          claim: "within 90 days of FLOP mainnet launch the winner signs a mainnet address with its OWNER key: keep the encrypted key backup" });
      } else {
        const dir = argv[1];
        if (!dir) { process.stderr.write("usage: audit-export <dir>\n"); return 2; }
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const [name, sql] of [["write_attempts", "SELECT * FROM write_attempts ORDER BY created_at"], ["live_trades", "SELECT * FROM live_trades ORDER BY created_at"],
          ["referee_posts", "SELECT * FROM raw_posts ORDER BY room, seq"], ["config_snapshots", "SELECT * FROM config_snapshots ORDER BY id"],
          ["keys_public", "SELECT id, did, role, status, registered, minted, minted_sweep, mint_evidence FROM keys WHERE fake = 0 ORDER BY id"],
          ["nonces", "SELECT * FROM nonces"], ["meta", "SELECT * FROM meta"], ["reconcile", "SELECT * FROM reconcile ORDER BY id"]] as const) {
          const rows = rdb.prepare(sql).all();
          writeFileSync(join(dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
        }
        out(`audit archive written to ${dir} (byte-exact signed requests, receipts, referee posts, config snapshots; no secrets)`);
      }
      return 0;
    } finally { rdb.close(); }
  }

  const db = openCloseCallDb(cfg.liveDbPath);
  if (cmd === "status") {
    out({ live_db: cfg.liveDbPath, writer: writerState(cfg), mode: cfg.mode, policy: cfg.confirmationPolicy, room: cfg.room,
      room_status: cfg.room ? getRoom(db, cfg.room).status : null, keys: keyStatusCounts(db),
      backup_gate: backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient }),
      pending_writes: (db.prepare("SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')").get() as { n: number }).n,
      halted: haltSummary(db) });
    return 0;
  }

  if (cmd === "unhalt") {
    const code = arg("--code");
    if (!code) { process.stderr.write("usage: live unhalt --code <code from live status>\n"); return 2; }
    const h = unhalt(db, code);
    out(h ? { cleared: h, live_db: cfg.liveDbPath, halted: haltSummary(db) } : { error: "no active halt with that code", halted: haltSummary(db) });
    return h ? 0 : 1;
  }

  if (cmd === "keygen") {
    const total = Number(arg("--total"));
    const role = (arg("--role") ?? "") as "admin" | "staging" | "strategy";
    if (!["admin", "staging", "strategy"].includes(role)) { process.stderr.write("keygen --role admin|staging|strategy --total N --i-understand-these-are-real-keys\n"); return 2; }
    if (!has("--i-understand-these-are-real-keys")) { process.stderr.write("keygen creates REAL keys: pass --i-understand-these-are-real-keys\n"); return 2; }
    if (cfg.dbPath !== cfg.liveDbPath || cfg.dataDir === "/var/lib/flop-closecall") { process.stderr.write("keygen only with the LIVE env (its own data dir): refusing\n"); return 3; }
    try {
      const r = generateKeys(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient, total, role });
      out({ created: r.created, existing: r.existing, next: "run closecall-backup.sh, verify it on the Mac, then keys --backup-verify: live writes stay blocked until then" });
      return 0;
    } catch (e) {
      if (e instanceof KeygenRefused) { process.stderr.write(`[CLOSECALL][KEYS] refused: ${e.message}\n`); return 3; }
      throw e;
    }
  }

  if (cmd === "bootstrap") {
    const w = writerState(cfg);
    if (!w.armed) {
      process.stderr.write(`[CLOSECALL][HALT] live writer DISARMED (${w.reason}): refusing. NO WRITE. (use --dry-run)\n`);
      return 3;
    }
    if (!cfg.room) { process.stderr.write("CLOSECALL_ROOM is not set\n"); return 2; }
    // The pre-write gate, every time (resume included). Journal rows in flight are allowed: the bootstrap reconciles them first.
    const pre = await liveReadiness(cfg, contest, "bootstrap", { envFile });
    const blocking = pre.rows.filter((x) => !x.ok && !x.bootOptional && x.name !== "pending writes");
    if (blocking.length) {
      process.stderr.write(`${renderReadiness(pre)}\n[CLOSECALL][HALT] pre-bootstrap gate FAILED (${blocking.map((x) => x.name).join(", ")}): refusing. NO WRITE.\n`);
      return 3;
    }
    const lock = await acquireLock(cfg.lockPath, "close-call live bootstrap"); // the SAME lock as the live service: never both at once
    setLogSink(cfg.logDir);
    const foldTest = isolatedTradeFold(cfg.python, cfg.vendorRoot, foldConfig(contest));   // started on first use (the staging trade)
    try {
      const limits = await fetchLimits(cfg.technocoreBaseUrl);
      db.prepare("INSERT INTO config_snapshots (source, json, at) VALUES (?, ?, ?)").run(limits.source, JSON.stringify(limits), new Date().toISOString());
      const perWriteMs = Math.ceil(60_000 / Math.max(1, Math.floor(limits.writesPerMinPerIp * cfg.writeBudgetFraction)));
      const signers = loadSigners(db, cfg.keysDir);
      const transport = new HttpTransport(cfg.technocoreBaseUrl);
      const observer = new RefereeObserver(db, cfg.technocoreBaseUrl, cfg.rawLogDir);
      const journal = new WriteJournal(db, signers, transport, { onAmbiguous: (row, why) => halt(db, "ambiguous_operation", `${row.op_key}: ${why}`),
        canWrite: () => { const x = writerState(cfg); return x.armed ? null : x.reason; } });
      await journal.recover();
      const b = new Bootstrap({
        db, contest, journal, transport, signers, policy: cfg.confirmationPolicy, room: cfg.room, clock: Date.now,
        refreshReferee: async () => { await observer.pollOnce(); },
        gate: () => backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient }),
        pace: async () => { await sleep(perWriteMs); }, refreshDays: cfg.roomRefreshDays, foldTest,
      });
      // --loop: keep stepping (resumable: every step re-derives its position from the DB and the server).
      let lim = limits;
      let limAt = Date.now();
      for (;;) {
        if (Date.now() - limAt > 600_000) { lim = await fetchLimits(cfg.technocoreBaseUrl).catch(() => lim); limAt = Date.now(); }
        const left = (db.prepare("SELECT COUNT(*) n FROM keys WHERE fake = 0 AND status = 'GENERATED'").get() as { n: number }).n;
        const perMin = Math.max(1, Math.floor(lim.writesPerMinPerIp * cfg.writeBudgetFraction));
        const r = await b.step();
        ccLog("BOOTSTRAP", { phase: r.phase, action: r.action, writes: r.writes, blockers: r.blockers?.slice(0, 3),
          owner_writes_left: left, write_budget_per_min: perMin, eta_writes_min: +(left / perMin).toFixed(1), server_limit: lim.writesPerMinPerIp }, r.detail);
        out(r);
        if (r.action === "halted" || r.action === "blocked") return 1;
        if (r.action === "done" || !has("--loop")) return 0;
        if (r.action === "waiting") await sleep(30_000);
      }
    } finally {
      foldTest.stop();
      lock.release();
    }
  }

  process.stderr.write("usage: cli-live <check | run | status | keygen --total N --i-understand-these-are-real-keys | restore-verify <dir> | bootstrap --dry-run [...]>\n");
  return 2;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
  if (e instanceof CloseCallConfigError) { process.stderr.write(`[CLOSECALL][CONFIG] ${e.message}\n`); process.exit(2); }
  if (e instanceof LockHeldError) { process.stderr.write(`[CLOSECALL][LOCK] ${e.message}\n`); process.exit(4); }
  process.stderr.write(`[CLOSECALL][ERROR] ${(e as Error).message}\n`);
  process.exit(1);
});
