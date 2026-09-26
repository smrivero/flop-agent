/**
 * Health report: everything an operator needs to judge the service from one call, read from the
 * database, the process and the filesystem. No keys, no signatures, no message bodies.
 */

import { statfsSync, statSync } from "node:fs";
import type { CloseCallConfig } from "./config.js";
import { lastClosedSweep, sweepTime, type Contest } from "./contest.js";
import { keyStatusCounts } from "./keys.js";
import { lockStatus } from "./lock.js";
import { activeHalts } from "./safety.js";
import type { CcDb } from "./store.js";

export interface RuntimeState {
  startedAt: number;
  observer: "running" | "starting" | "error" | "stopped";
  observerLastOkAt: number | null;
  strategy: "running" | "halted" | "disabled";
  executor: "paper" | "live" | "disabled";
  lastError: string | null;
  reconnects: number;
  timeouts: number;
}

export interface Health {
  status: "ok" | "degraded" | "halted";
  mode: string;
  process: { pid: number; uptime_s: number; rss_mb: number; heap_mb: number; lock: ReturnType<typeof lockStatus> };
  sweep: { current_by_clock: number; last_received: number | null; seconds_since_referee_update: number | null; referee_delay_min: number | null; last_age_s: number | null };
  hyperliquid: { last_px: string | null; age_s: number | null };
  db: { ok: boolean; path: string; size_mb: number; schema_version: number };
  disk: { free_mb: number; low: boolean };
  observer: string; strategy: string; executor: string;
  execution_halted: boolean; halts: string[];
  reconciliation: { l1: string | null; l2: string | null };
  keys: Record<string, number>;
  pending_writes: number;
  unresolved_trades: number;
  last_error: string | null;
  counters: { reconnects: number; timeouts: number; alerts_24h: number };
}

export function health(db: CcDb, cfg: CloseCallConfig, contest: Contest, rt: RuntimeState, nowMs = Date.now()): Health {
  const last = db.prepare("SELECT n, age_s, updated_at FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n DESC LIMIT 1").get() as { n: number; age_s: number | null; updated_at: string } | undefined;
  const lastRaw = db.prepare("SELECT MAX(fetched_at) t FROM raw_posts WHERE room LIKE 'd-close1-%'").get() as { t: string | null };
  const hl = db.prepare("SELECT px, time_ms FROM hl_trades ORDER BY time_ms DESC LIMIT 1").get() as { px: string; time_ms: number } | undefined;
  const l1 = db.prepare("SELECT status || ' @' || COALESCE(n, '-') s FROM reconcile WHERE level = 'L1-referee' ORDER BY id DESC LIMIT 1").get() as { s: string } | undefined;
  const l2 = db.prepare("SELECT status || ' ' || level s FROM reconcile WHERE level LIKE 'L2%' ORDER BY id DESC LIMIT 1").get() as { s: string } | undefined;
  const pending = (db.prepare("SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')").get() as { n: number }).n;
  const unresolved = (db.prepare("SELECT COUNT(*) n FROM intents WHERE risk_status = 'OK' AND outcome IS NULL").get() as { n: number }).n;
  const alerts24 = (db.prepare("SELECT COUNT(*) n FROM alerts WHERE at > ?").get(new Date(nowMs - 86_400_000).toISOString()) as { n: number }).n;
  let dbOk = true;
  try { dbOk = db.pragma("quick_check", { simple: true }) === "ok"; } catch { dbOk = false; }
  let size = 0;
  try { size = statSync(cfg.dbPath).size; } catch { /* not yet */ }
  let free = 0;
  try { const s = statfsSync(cfg.dataDir); free = (s.bavail * s.bsize) / 1_048_576; } catch { /* unknown */ }
  const halts = Object.values(activeHalts(db));
  const mem = process.memoryUsage();
  const refDelay = last ? Math.max(0, (nowMs - sweepTime(contest, last.n + 1)) / 60_000) : null;
  const status = halts.length ? "halted" : (!dbOk || rt.observer === "error" || free < cfg.diskLowMb ? "degraded" : "ok");
  return {
    status,
    mode: cfg.mode,
    process: { pid: process.pid, uptime_s: Math.round((nowMs - rt.startedAt) / 1000), rss_mb: +(mem.rss / 1_048_576).toFixed(1), heap_mb: +(mem.heapUsed / 1_048_576).toFixed(1), lock: lockStatus(cfg.lockPath) },
    sweep: {
      current_by_clock: lastClosedSweep(contest, nowMs), last_received: last?.n ?? null,
      seconds_since_referee_update: lastRaw.t ? Math.round((nowMs - Date.parse(lastRaw.t)) / 1000) : null,
      referee_delay_min: refDelay === null ? null : +refDelay.toFixed(1), last_age_s: last?.age_s ?? null,
    },
    hyperliquid: { last_px: hl?.px ?? null, age_s: hl ? Math.round((nowMs - hl.time_ms) / 1000) : null },
    db: { ok: dbOk, path: cfg.dbPath, size_mb: +(size / 1_048_576).toFixed(2), schema_version: db.pragma("user_version", { simple: true }) as number },
    disk: { free_mb: Math.round(free), low: free < cfg.diskLowMb },
    observer: rt.observer, strategy: halts.length ? "halted" : rt.strategy, executor: rt.executor,
    execution_halted: halts.length > 0, halts: halts.map((h) => `${h.kind}${h.severity === "grave" ? ` (grave, code ${h.code})` : ""}: ${h.reason}`),
    reconciliation: { l1: l1?.s ?? null, l2: l2?.s ?? null },
    keys: keyStatusCounts(db),
    pending_writes: pending,
    unresolved_trades: unresolved,
    last_error: rt.lastError,
    counters: { reconnects: rt.reconnects, timeouts: rt.timeouts, alerts_24h: alerts24 },
  };
}

/** Prometheus text exposition of the numeric health fields. */
export function metrics(h: Health): string {
  const g = (name: string, v: number | null | boolean, help: string) =>
    v === null ? "" : `# HELP closecall_${name} ${help}\n# TYPE closecall_${name} gauge\nclosecall_${name} ${typeof v === "boolean" ? (v ? 1 : 0) : v}\n`;
  return [
    g("uptime_seconds", h.process.uptime_s, "process uptime"),
    g("rss_megabytes", h.process.rss_mb, "resident memory"),
    g("sweep_current", h.sweep.current_by_clock, "sweep by the clock"),
    g("sweep_last_received", h.sweep.last_received, "last referee sweep stored"),
    g("referee_update_age_seconds", h.sweep.seconds_since_referee_update, "seconds since the last referee message was read"),
    g("referee_delay_minutes", h.sweep.referee_delay_min, "how late the referee is publishing"),
    g("referee_age_s", h.sweep.last_age_s, "age_s of the last reference"),
    g("hyperliquid_age_seconds", h.hyperliquid.age_s, "age of the last xyz:NVDA trade seen"),
    g("db_ok", h.db.ok, "sqlite quick_check"),
    g("db_size_megabytes", h.db.size_mb, "database size"),
    g("disk_free_megabytes", h.disk.free_mb, "free disk in the data directory"),
    g("execution_halted", h.execution_halted, "1 while any halt is active"),
    g("pending_writes", h.pending_writes, "journal writes not final"),
    g("unresolved_trades", h.unresolved_trades, "intents without a referee outcome"),
    g("reconnects_total", h.counters.reconnects, "observer reconnects"),
    g("timeouts_total", h.counters.timeouts, "request timeouts"),
  ].join("");
}
