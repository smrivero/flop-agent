/**
 * LIVE ONLY. `live-check`: every condition live execution needs, verified WITHOUT writing anything
 * (databases opened read-only, key files only read and self-tested in memory, no network write).
 * `cli-live run` refuses to start unless this passes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CloseCallConfig } from "../config.js";
import type { Contest } from "../contest.js";
import { backupGate } from "../backup-gate.js";
import { listKeys, isTradable } from "../keys.js";
import { openReadonly } from "../monitor.js";
import { liveStrategyKeys } from "../paper.js";
import { activeHalts } from "../safety.js";
import { getMeta } from "../store.js";
import { loadSigners } from "./keygen.js";

export interface ReadinessRow { name: string; ok: boolean; value: string }

export function liveReadiness(cfg: CloseCallConfig, contest: Contest, writerConnected: boolean, nowMs = Date.now()): { pass: boolean; rows: ReadinessRow[] } {
  const rows: ReadinessRow[] = [];
  const add = (name: string, ok: boolean, value: string) => rows.push({ name, ok, value });
  add("mode", cfg.mode === "live", cfg.mode === "live" ? "LIVE candidate" : `${cfg.mode.toUpperCase()} (CLOSECALL_MODE=live + ack required)`);
  add("writer", writerConnected, writerConnected ? "READY" : "NOT CONNECTED (LIVE_WRITER_CONNECTED = false)");
  add("lock path", cfg.lockPath !== join(cfg.dataDir, "closecall.lock"), cfg.lockPath === join(cfg.dataDir, "closecall.lock") ? "same lock as the paper service: set CLOSECALL_LOCK_PATH" : cfg.lockPath);
  add("live database", cfg.dbPath === cfg.liveDbPath && existsSync(cfg.liveDbPath), cfg.dbPath === cfg.liveDbPath ? cfg.liveDbPath : `CLOSECALL_DB_PATH must equal CLOSECALL_LIVE_DB_PATH (${cfg.liveDbPath})`);
  const { db, error } = openReadonly(cfg.liveDbPath);
  if (!db) {
    add("live DB readable", false, error ?? "unavailable");
    return { pass: false, rows };
  }
  try {
    const real = listKeys(db).filter((k) => k.fake === 0);
    const ready = real.filter((k) => isTradable(k.status));
    let signersOk = false;
    let signerDetail = "";
    try { signersOk = loadSigners(db).size === real.length && real.length > 0; signerDetail = `${real.length} loaded, self-tested`; } catch (e) { signerDetail = (e as Error).message; }
    add("real keys", ready.length >= 2 && ready.length === real.length, `${ready.length} READY of ${real.length}${real.some((k) => k.fake) ? " (fake keys present!)" : ""}`);
    add("key files", signersOk, signerDetail || "none");
    const strat = liveStrategyKeys(db);
    add("strategy keys", strat.length >= 2, `${strat.length} (${strat.length / 2} pairs; bootstrap/probe keys excluded)`);
    const gate = backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient });
    add("encrypted backup", !!cfg.backupAgeRecipient && !!gate.verified && !gate.problems.some((p) => /archive/.test(p)), gate.verified ? gate.verified.archive : "none verified");
    add("restore verification", gate.ok, gate.ok ? `verified ${gate.verified!.verified_at.slice(0, 16)}, ${gate.verified!.files.length} key files` : gate.problems.join("; "));
    const room = cfg.room ? (db.prepare("SELECT status FROM rooms_state WHERE name = ?").get(cfg.room) as { status: string } | undefined)?.status ?? "UNCREATED" : null;
    add("room", room === "READY", cfg.room ? `${cfg.room} ${room}` : "CLOSECALL_ROOM not set");
    add("bootstrap", !!getMeta(db, "bootstrap_done_at"), getMeta(db, "bootstrap_done_at") ?? "not done");
    add("confirmation policy", ["STRICT", "PROTOCOL", "PROBE"].includes(cfg.confirmationPolicy), cfg.confirmationPolicy);
    const future = (db.prepare("SELECT COUNT(*) n FROM nonces WHERE CAST(last_nonce AS INTEGER) > ?").get(nowMs + 86_400_000) as { n: number }).n;
    add("nonce store", future === 0, future ? `${future} nonces more than a day ahead of the clock` : `${(db.prepare("SELECT COUNT(*) n FROM nonces").get() as { n: number }).n} scopes persisted`);
    // Freshness: the live DB, or the paper service's DB (same referee/Hyperliquid) before live has run.
    const paper = openReadonly(join(cfg.dataDir, "close-call.sqlite3")).db;
    const fresh = (sql: string) => Math.max(...[db, paper].filter(Boolean).map((d) => { try { const v = (d!.prepare(sql).get() as { t: string | number | null }).t; return v === null ? 0 : typeof v === "number" ? v : Date.parse(v); } catch { return 0; } }));
    const ref = fresh("SELECT MAX(fetched_at) t FROM raw_posts WHERE room LIKE 'd-close1-%'");
    const hl = fresh("SELECT MAX(observed_at_ms) t FROM hl_trades");
    paper?.close();
    add("referee", ref > 0 && nowMs - ref < 600_000, ref ? `last read ${Math.round((nowMs - ref) / 1000)}s ago` : "never read");
    add("Hyperliquid", hl > 0 && nowMs - hl < 120_000, hl ? `last trade seen ${Math.round((nowMs - hl) / 1000)}s ago` : "never seen");
    const st = getMeta(db, "halts");
    const halts = Object.values(activeHalts(db));
    add("Strategy K", halts.length === 0, halts.length ? `HALTED: ${halts.map((h) => h.kind).join(", ")}` : st !== null ? "READY" : "READY (fresh state)");
    const pending = (db.prepare("SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')").get() as { n: number }).n;
    add("pending writes", pending === 0, String(pending));
    const unknown = (db.prepare("SELECT COUNT(*) n FROM live_trades WHERE state = 'UNKNOWN'").get() as { n: number }).n;
    add("unknown trades", unknown === 0, String(unknown));
    add("contest", nowMs < contest.firstSweepMs + (contest.lockSweep - 1) * contest.sweepMs, "before the lock");
  } finally {
    db.close();
  }
  return { pass: rows.every((r) => r.ok), rows };
}

export function renderReadiness(r: { pass: boolean; rows: ReadinessRow[] }): string {
  return [...r.rows.map((x) => `${x.name.padEnd(24)}${x.ok ? "" : "FAIL  "}${x.value}`), "", `LIVE READINESS: ${r.pass ? "PASS" : "FAIL"}`].join("\n");
}
