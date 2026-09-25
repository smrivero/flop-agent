/**
 * closecall CLI. Nothing here can write to Technocore.
 *
 * Service (take the single-instance lock, print the mode banner, integrity-check the DB):
 *   run          the service entry point: CLOSECALL_MODE (paper by default, observe, dry-run).
 *                live is refused in this build even when both live settings are present.
 *   paper | observe | dry-run   explicit forms of the same
 * Read-only views (no lock; safe beside the running service):
 *   status  health  positions  leaderboard  keys [--validate]  pending  report
 * Maintenance:
 *   reconcile          re-run L1 on every stored sweep and replay the paper books (L2)
 *   backup             consistent online SQLite backup into data/close-call/backups/
 *   restore-check <f>  integrity + schema + row counts of a backup file
 *   unhalt --code <c>  clear a GRAVE halt (the code is shown by status/health)
 * Options: --minutes N (service commands stop after N minutes), --json.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CloseCallConfigError, loadCloseCallConfig } from "./config.js";
import { lastClosedSweep, loadContest } from "./contest.js";
import { OfficialFold } from "./fold.js";
import { health, type RuntimeState } from "./health.js";
import { HyperliquidObserver } from "./hyperliquid.js";
import { listKeys } from "./keys.js";
import { validateKeyDir } from "./keystore.js";
import { bootstrapPlan, fetchLimits } from "./limits.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { ccLog, setLogSink } from "./logger.js";
import { RefereeObserver } from "./observer.js";
import { foldConfig, PaperTrader } from "./paper.js";
import { reconcileReferee } from "./reconcile.js";
import { report } from "./report.js";
import { banner, runLoop } from "./run.js";
import { unhalt } from "./safety.js";
import { snapshot } from "./status.js";
import { backupDb, openCloseCallDb, SCHEMA_VERSION } from "./store.js";

export const COMMANDS = ["run", "paper", "observe", "dry-run", "status", "health", "positions", "leaderboard", "keys", "pending", "report",
  "reconcile", "backup", "restore-check", "unhalt", "bootstrap-plan"] as const;

const out = (v: unknown) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) {
    process.stderr.write(`usage: closecall <${COMMANDS.join("|")}> [--minutes N]\n`);
    return 2;
  }
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const env = { ...process.env };
  if (cmd === "paper" || cmd === "observe" || cmd === "dry-run") env.CLOSECALL_MODE = cmd;   // an explicit command always wins; `run` follows CLOSECALL_MODE
  const cfg = loadCloseCallConfig(env);
  const contest = loadContest(cfg.vendorRoot);

  if (["run", "paper", "observe", "dry-run"].includes(cmd)) {
    process.stdout.write(banner(cfg.mode) + "\n");
    if (cfg.mode === "live") {
      process.stderr.write("[CLOSECALL][HALT] live execution is not connected in this build: refusing to start. NO WRITE.\n");
      return 3;
    }
    let lock;
    try {
      lock = await acquireLock(cfg.lockPath);
    } catch (e) {
      if (e instanceof LockHeldError) { process.stderr.write(`[CLOSECALL][LOCK] ${e.message}\n`); return 4; }
      throw e;
    }
    setLogSink(cfg.logDir, { maxFileBytes: cfg.logs.maxFileMb * 1_048_576, maxTotalBytes: cfg.logs.maxTotalMb * 1_048_576, retentionDays: cfg.logs.retentionDays });
    ccLog("LOCK", { path: cfg.lockPath, pid: lock.info.pid }, "single-instance lock held");
    const db = openCloseCallDb(cfg.dbPath, { checkIntegrity: true });
    ccLog("MODE", { mode: cfg.mode, db: cfg.dbPath, schema: SCHEMA_VERSION, data_dir: cfg.dataDir }, `${cfg.mode.toUpperCase()} MODE`);
    try {
      if (cfg.mode === "dry-run") return await dryRun(db, cfg, contest);
      await runLoop(db, cfg, contest, { paper: cfg.mode === "paper", maxMinutes: arg("--minutes") ? Number(arg("--minutes")) : undefined });
      return 0;
    } finally {
      db.close();
      lock.release();
    }
  }

  if (cmd === "bootstrap-plan") {
    const limits = await fetchLimits(cfg.technocoreBaseUrl);
    out(bootstrapPlan(limits, cfg.strategy.keyCount, Number(arg("--lag") ?? "0")));
    return 0;
  }
  if (cmd === "restore-check") {
    const file = argv[1];
    if (!file || !existsSync(file)) { process.stderr.write("usage: closecall restore-check <backup.sqlite3>\n"); return 2; }
    const b = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = b.pragma("integrity_check", { simple: true });
    const tables = ["sweeps", "raw_posts", "keys", "intents", "trades", "write_attempts", "nonces", "alerts"];
    const counts = Object.fromEntries(tables.map((t) => { try { return [t, (b.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n]; } catch { return [t, "missing"]; } }));
    out({ file, integrity, schema_version: b.pragma("user_version", { simple: true }), expected_schema: SCHEMA_VERSION, counts });
    b.close();
    return integrity === "ok" ? 0 : 1;
  }

  const db = openCloseCallDb(cfg.dbPath);
  try {
    switch (cmd) {
      case "status": out(snapshot(db)); return 0;
      case "health": {
        const rt: RuntimeState = { startedAt: Date.now(), observer: "stopped", observerLastOkAt: null, strategy: "disabled", executor: "disabled", lastError: null, reconnects: 0, timeouts: 0 };
        const h = health(db, cfg, contest, rt);
        out({ ...h, note: "computed by the CLI from the database; the running service's own view is at http://127.0.0.1:<port>/health" });
        return h.status === "ok" ? 0 : 1;
      }
      case "positions": {
        const n = (db.prepare("SELECT MAX(n) m FROM positions WHERE book = 'paper'").get() as { m: number | null }).m;
        out({ sweep: n, book: "paper (fake keys)", positions: n === null ? [] : db.prepare("SELECT key_id, position, cash, fees, value, mark FROM positions WHERE n = ? AND book = 'paper' ORDER BY key_id").all(n) });
        return 0;
      }
      case "leaderboard": {
        const s = db.prepare("SELECT n, mark, pnl_top FROM sweeps WHERE pnl_top IS NOT NULL ORDER BY n DESC LIMIT 1").get() as { n: number; mark: string; pnl_top: string } | undefined;
        const n = (db.prepare("SELECT MAX(n) m FROM positions WHERE book = 'paper'").get() as { m: number | null }).m;
        const ours = n === null ? [] : (db.prepare("SELECT key_id, value FROM positions WHERE n = ? AND book = 'paper' ORDER BY CAST(value AS REAL) DESC LIMIT 3").all(n) as { key_id: string; value: string }[])
          .map((r) => ({ key: r.key_id, score: (Number(r.value) - 10_000).toFixed(2) }));
        out({ referee: s ? { sweep: s.n, mark: s.mark, top: JSON.parse(s.pnl_top).slice(0, 10) } : null, our_paper_top3: ours });
        return 0;
      }
      case "keys": {
        if (argv.includes("--validate")) {
          const r = validateKeyDir(cfg.keysDir, cfg.backupDir);
          out(r);
          return r.problems.length && r.files.length ? 1 : 0;
        }
        for (const k of listKeys(db)) {
          out(`${k.id} ${k.status.padEnd(16)} fake=${k.fake} role=${k.strategy_role ?? "-"} pair=${k.pair_index ?? "-"} entry=${k.entry_px ?? "-"}@${k.entry_sweep ?? "-"} ${k.did}`);
        }
        return 0;
      }
      case "pending":
        out({
          writes: db.prepare("SELECT op_key, kind, state, tries, http_status, error, updated_at FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED') ORDER BY created_at").all(),
          intents_awaiting_referee: db.prepare("SELECT sweep, pair_index, trade_id, favored, qty, px, created_at FROM intents WHERE risk_status = 'OK' AND outcome IS NULL ORDER BY sweep").all(),
          trades_open: db.prepare("SELECT trade_id, kind, status, until, updated_at FROM trades WHERE status NOT IN ('settled','never-settled','void-final') ORDER BY created_at").all(),
          keys_pending: db.prepare("SELECT id, status FROM keys WHERE status IN ('REGISTER_PENDING','MINT_EXPECTED','PROBE_PENDING','ERROR') ORDER BY id").all(),
        });
        return 0;
      case "report": out(report(db)); return 0;
      case "unhalt": {
        const code = arg("--code");
        if (!code) { process.stderr.write("usage: closecall unhalt --code <code from status>\n"); return 2; }
        const h = unhalt(db, code);
        out(h ? { cleared: h } : { error: "no active halt with that code" });
        return h ? 0 : 1;
      }
      case "backup": {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dest = join(cfg.backupDir, `close-call-${stamp}.sqlite3`);
        const r = await backupDb(db, dest);
        const check = new Database(dest, { readonly: true });
        const integrity = check.pragma("integrity_check", { simple: true });
        check.close();
        const keep = Number(arg("--keep") ?? "14");
        const olds = readdirSync(cfg.backupDir).filter((f) => /^close-call-.*\.sqlite3$/.test(f)).sort().reverse().slice(keep);
        for (const f of olds) unlinkSync(join(cfg.backupDir, f));
        out({ backup: dest, pages: r.pages, bytes: statSync(dest).size, integrity, pruned: olds });
        return integrity === "ok" ? 0 : 1;
      }
      case "reconcile": {
        setLogSink(cfg.logDir);
        const l1 = reconcileReferee(db, { recheck: true, haltOnMismatch: false });
        const bad = l1.filter((r) => r.status === "MISMATCH");
        ccLog(bad.length ? "RECONCILE MISMATCH" : "RECONCILE OK", { level: "L1 referee (all stored sweeps)", sweeps: l1.length, mismatches: bad.length });
        const main = await OfficialFold.start(cfg.python, cfg.vendorRoot, foldConfig(contest));
        const look = await OfficialFold.start(cfg.python, cfg.vendorRoot, foldConfig(contest));
        try {
          await new PaperTrader(db, cfg, contest, main, look, null).start();
        } finally {
          main.stop();
          look.stop();
        }
        return bad.length ? 1 : 0;
      }
    }
  } finally {
    db.close();
  }
  return 2;
}

async function dryRun(db: import("./store.js").CcDb, cfg: import("./config.js").CloseCallConfig, contest: import("./contest.js").Contest): Promise<number> {
  const observer = new RefereeObserver(db, cfg.technocoreBaseUrl, cfg.rawLogDir);
  const hl = new HyperliquidObserver(db, cfg.hyperliquidInfoUrl, cfg.hyperliquidCoin);
  await observer.pollOnce();
  await hl.pollOnce();
  const main = await OfficialFold.start(cfg.python, cfg.vendorRoot, foldConfig(contest));
  const look = await OfficialFold.start(cfg.python, cfg.vendorRoot, foldConfig(contest));
  try {
    const paper = new PaperTrader(db, cfg, contest, main, look, hl);
    await paper.start();
    const n = lastClosedSweep(contest, Date.now()) + 1;
    ccLog("START", { mode: "dry-run", sweep: n }, "deciding the next sweep once; nothing is stored or sent");
    await paper.decide(n, false);
  } finally {
    main.stop();
    look.stop();
  }
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  if (e instanceof CloseCallConfigError) {
    process.stderr.write(`[CLOSECALL][CONFIG] ${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`[CLOSECALL][ERROR] ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
