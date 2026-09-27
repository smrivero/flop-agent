/**
 * Terminal monitor: `closecall status` (one snapshot) and `closecall watch [--interval N]`.
 *
 * 100% READ ONLY:
 *   - SQLite is opened with { readonly: true } (never openCloseCallDb: no migration, no pragma write);
 *   - the service's own view comes from GET http://127.0.0.1:<port>/health;
 *   - systemd from `systemctl show` (a read);
 *   - version from .git files, 503 counts from the tail of today's log file.
 * It never contacts Technocore or Hyperliquid, never signs, never writes a file.
 *
 * Every metric is optional: a missing table, a stopped service or an unreadable database shows
 * N/A / SERVICE DOWN / DB ERROR and the rest keeps rendering.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CloseCallConfig } from "./config.js";
import { lastClosedSweep, sweepTime, type Contest } from "./contest.js";
import type { Health } from "./health.js";
import { KEY_STATUSES } from "./keys.js";
import { lockStatus } from "./lock.js";
import { collectLive, JOURNAL_STATES, KEY_FLAGS, type LiveMonitor } from "./monitor-live.js";
import { writerState } from "./safety.js";
import { decideStale, type StaleDecision } from "./stale-policy.js";

// ------------------------------------------------------------------ data

type N<T> = T | null;

export interface SystemdInfo { active: string; sub: string; pid: N<number>; restarts: N<number>; since: N<number>; memoryMb: N<number>; cpuNs: N<number> }

export interface MonitorData {
  at: number;
  host: string;
  mode: string;
  version: string;
  service: { state: "OK" | "DOWN" | "UNKNOWN"; systemd: N<string>; pid: N<number>; uptimeS: N<number>; rssMb: N<number>; cpuPct: N<number>; restarts: N<number>;
    lock: "OK" | "ERROR" | "N/A"; lockDetail: string; db: "OK" | "ERROR"; dbError: N<string>; diskFreeMb: N<number>; dbSizeMb: N<number>; walMb: N<number>; healthOk: boolean };
  contest: { season: string; currentSweep: N<number>; lastSweep: N<number>; secSinceReferee: N<number>; refereeDelayMin: N<number>; ageS: N<number>;
    ref: N<string>; refSweep: N<number>; close: N<string>; global: N<string> };
  hl: { px: N<string>; ageS: N<number>; time: N<string>; stale: "OK" | "STALE" | "HALT" | "N/A"; vsRefBps: N<number>; vsCloseBps: N<number>; feedAgeS: N<number> };
  env: { dataDir: string; db: string; node: string; sqlite: string; writerArmed: boolean; writerReason: string; policy: string; estimator: string };
  keys: { total: number; by: Record<string, number>; kind: "FAKE" | "REAL" | "N/A" };
  positions: { sweep: N<number>; markSweep: N<number>; mark: N<string>; long: N<number>; short: N<number>; flat: N<number>; longQty: N<number>; shortQty: N<number>; cash: N<number>;
    collateral: N<number>; fees: N<number>; realized: N<number>; markPnl: N<number>; top: { id: string; side: string; entry: N<string>; qty: number; score: number }[] };
  leaderboard: { sweep: N<number>; mark: N<string>; global: { who: string; score: string }[]; ours: { id: string; score: number }[]; rank: string };
  strategy: { status: string; threshold: number; lo: N<number>; hi: N<number>; nextLo: N<number>; nextHi: N<number>; pairsUsed: N<number>; pairsUnused: N<number>;
    lastTrigger: N<string>; lastTriggerSweep: N<number>; estimator: N<string>; stale: N<StaleDecision>; staleReason: N<string> };
  trades: { simulated: boolean; total: N<number>; settled: N<number>; void: N<number>; pending: N<number>; unknown: N<number>;
    recent: { id: string; maker: string; taker: string; side: string; qty: string; px: string; sweep: number; status: string; fee: N<string> }[] };
  security: { executor: string; writes: "DISABLED" | "ENABLED"; halted: N<boolean>; safeMode: string; haltReason: N<string>; pendingWrites: N<number>; unresolved: N<number>; nonceErrors: N<number> };
  reconcile: { l1: N<string>; l1Sweep: N<number>; l2: N<string>; mismatches: N<number>; sinceStart: N<number>; lastMismatch: N<string> };
  live: LiveMonitor | null;
  errors: { reconnects: N<number>; timeouts: N<number>; http503: N<number>; alerts24h: N<number>; alertsSinceStart: N<number>; lastAlerts: { at: string; severity: string; message: string }[] };
  activity: { refereeS: N<number>; hlS: N<number>; strategyS: N<number>; dbWriteS: N<number>; technocoreWriteS: N<number>; journalS: N<number>; nonceReconcileS: N<number>; backupVerifyS: N<number> };
  processStart: N<string>;
}

export interface MonitorSources {
  cfg: CloseCallConfig;
  contest: Contest;
  now?: number;
  /** systemd unit state; null when systemctl is unavailable. */
  systemd?: () => SystemdInfo | null;
  /** The running service's /health; null when it does not answer. */
  fetchHealth?: () => Promise<Health | null>;
  version?: () => string;
  /** NTP probe override (tests). */
  ntp?: () => boolean | null;
  /** Previous sample, for a CPU % between two watch frames. */
  prev?: { at: number; cpuNs: number } | null;
}

const safe = <T>(f: () => T, dflt: T): T => { try { return f(); } catch { return dflt; } };

export function readSystemd(unit = "flop-closecall.service"): SystemdInfo | null {
  try {
    const outp = execFileSync("systemctl", ["show", unit, "--timestamp=unix", "--property=ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp,MemoryCurrent,CPUUsageNSec"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const p = Object.fromEntries(outp.trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    const n = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
    const since = p.ActiveEnterTimestamp?.startsWith("@") ? Number(p.ActiveEnterTimestamp.slice(1)) * 1000 : null;
    return { active: p.ActiveState ?? "unknown", sub: p.SubState ?? "", pid: n(p.MainPID) || null, restarts: n(p.NRestarts), since,
      memoryMb: n(p.MemoryCurrent) !== null ? +(n(p.MemoryCurrent)! / 1_048_576).toFixed(1) : null, cpuNs: n(p.CPUUsageNSec) };
  } catch {
    return null;
  }
}

export async function fetchHealth(cfg: CloseCallConfig): Promise<Health | null> {
  if (!cfg.health.enabled) return null;
  try {
    const res = await fetch(`http://${cfg.health.host === "0.0.0.0" ? "127.0.0.1" : cfg.health.host}:${cfg.health.port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200 || res.status === 503 ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

/** Short commit from .git (no git process: the checkout may belong to another user). */
export function readVersion(dir = process.cwd()): string {
  const pkg = safe(() => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? "?", "?");
  const commit = safe(() => {
    const head = readFileSync(join(dir, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head.slice(0, 7);
    const ref = head.slice(5);
    if (existsSync(join(dir, ".git", ref))) return readFileSync(join(dir, ".git", ref), "utf8").trim().slice(0, 7);
    const packed = readFileSync(join(dir, ".git/packed-refs"), "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : "?";
  }, "N/A");
  return `v${pkg} ${commit}`;
}

function vmRssMb(pid: number | null): number | null {
  if (!pid) return null;
  return safe(() => {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+) kB/m);
    return m ? +(Number(m[1]) / 1024).toFixed(1) : null;
  }, null);
}

/** Count "-> 503" in the last `maxBytes` of today's structured log (read only). */
function count503(logDir: string, now: number, maxBytes = 4 * 1_048_576): number | null {
  const day = new Date(now).toISOString().slice(0, 10);
  const files = safe(() => (existsSync(logDir) ? readdirSync(logDir).filter((f) => f.startsWith(`events-${day}`)) : []), [] as string[]);
  if (!files.length) return null;
  let total = 0;
  for (const f of files) {
    const p = join(logDir, f);
    const size = statSync(p).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(p, "r");
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    total += (buf.toString("utf8").match(/-> 503/g) ?? []).length;
  }
  return total;
}

/**
 * Open without any side effect. With a -wal file present (service running, or stopped uncleanly) a normal
 * read-only reader is used (SQLite only takes its reader marks in -shm). Without one (service stopped
 * cleanly), a read-only connection would CREATE -wal/-shm, so the file is read into memory instead,
 * with the header's WAL flag cleared in that private copy.
 */
export function openReadonly(path: string): { db: Database.Database | null; error: string | null } {
  if (!existsSync(path)) return { db: null, error: `not found: ${path}` };
  try {
    if (!existsSync(path + "-wal")) {
      const buf = readFileSync(path);
      if (buf.length >= 100 && buf[18] === 2 && buf[19] === 2) { buf[18] = 1; buf[19] = 1; }
      const mem = new Database(buf);
      mem.pragma("query_only = ON");
      return { db: mem, error: null };
    }
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 });
    db.pragma("query_only = ON");
    return { db, error: null };
  } catch (e) {
    return { db: null, error: (e as Error).message };
  }
}

const bps = (a: number, b: number) => ((a - b) / b) * 10_000;

export async function collect(src: MonitorSources): Promise<MonitorData> {
  const { cfg, contest } = src;
  const now = src.now ?? Date.now();
  const sd = safe(() => (src.systemd ?? readSystemd)(), null);
  const h = await safe(() => (src.fetchHealth ?? (() => fetchHealth(cfg)))(), Promise.resolve(null)).catch(() => null);
  const live = cfg.mode === "live";
  const { db, error: dbError } = openReadonly(cfg.dbPath);
  // Keys, trades and the write journal live in the live DB in live mode, in the paper DB otherwise.
  const exec = live ? openReadonly(cfg.liveDbPath).db : db;
  const q = <T>(d: Database.Database | null, sql: string, ...args: unknown[]): T | undefined => (d ? safe(() => d.prepare(sql).get(...args) as T | undefined, undefined) : undefined);
  const qa = <T>(d: Database.Database | null, sql: string, ...args: unknown[]): T[] => (d ? safe(() => d.prepare(sql).all(...args) as T[], []) : []);
  const secs = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null);

  // ---- service
  const lk = safe(() => lockStatus(cfg.lockPath), { present: false, held: false, info: null });
  const running = sd ? sd.active === "active" : (h !== null || lk.held);
  const pid = sd?.pid ?? h?.process.pid ?? lk.info?.pid ?? null;
  const uptimeS = h ? h.process.uptime_s : sd?.since ? Math.round((now - sd.since) / 1000) : null;
  let cpuPct: number | null = null;
  if (sd?.cpuNs !== null && sd?.cpuNs !== undefined) {
    if (src.prev && now > src.prev.at) cpuPct = +(((sd.cpuNs - src.prev.cpuNs) / 1e6 / (now - src.prev.at)) * 100).toFixed(1);
    else if (uptimeS) cpuPct = +((sd.cpuNs / 1e9 / uptimeS) * 100).toFixed(1);
  }
  let dbOk = !!db;
  let dbErr = dbError;
  if (db) {
    const qc = safe(() => db.pragma("quick_check", { simple: true }) as string, "error");
    if (qc !== "ok") { dbOk = false; dbErr = `quick_check: ${qc}`; }
  }
  const fsize = (p: string) => safe(() => +(statSync(p).size / 1_048_576).toFixed(2), null);
  const service: MonitorData["service"] = {
    state: sd ? (running ? "OK" : "DOWN") : h ? "OK" : lk.held ? "OK" : "DOWN",
    systemd: sd ? `${sd.active}${sd.sub ? `/${sd.sub}` : ""}` : null,
    pid: running ? pid : null, uptimeS: running ? uptimeS : null,
    rssMb: running ? h?.process.rss_mb ?? vmRssMb(pid) ?? sd?.memoryMb ?? null : null,
    cpuPct: running ? cpuPct : null, restarts: sd?.restarts ?? null,
    lock: running ? (lk.held ? "OK" : "ERROR") : lk.held ? "ERROR" : "N/A",
    lockDetail: lk.held ? `pid ${lk.info?.pid}` : lk.present ? "stale lock file" : "no lock",
    db: dbOk ? "OK" : "ERROR", dbError: dbErr,
    diskFreeMb: safe(() => { const s = statfsSync(cfg.dataDir); return Math.round((s.bavail * s.bsize) / 1_048_576); }, null),
    dbSizeMb: fsize(cfg.dbPath), walMb: fsize(cfg.dbPath + "-wal"), healthOk: h !== null,
  };

  // ---- contest / referee
  type SweepRow = { n: number; ref_px: string | null; age_s: number | null; global: string | null };
  const last = q<SweepRow>(db, "SELECT n, ref_px, age_s, global FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n DESC LIMIT 1");
  const prev = last ? q<SweepRow>(db, "SELECT n, ref_px, age_s, global FROM sweeps WHERE ref_px IS NOT NULL AND n < ? ORDER BY n DESC LIMIT 1", last.n) : undefined;
  const lastRaw = q<{ t: string | null }>(db, "SELECT MAX(fetched_at) t FROM raw_posts WHERE room LIKE 'd-close1-%'")?.t ?? null;
  const delay = last ? Math.max(0, (now - sweepTime(contest, last.n + 1)) / 60_000) : null;
  const contestD: MonitorData["contest"] = {
    season: contest.contestId, currentSweep: lastClosedSweep(contest, now), lastSweep: last?.n ?? null, secSinceReferee: secs(lastRaw),
    refereeDelayMin: delay === null ? null : +delay.toFixed(1), ageS: last?.age_s ?? null,
    ref: prev?.ref_px ?? null, refSweep: prev?.n ?? null, close: last?.ref_px ?? null, global: last?.global ?? null,
  };

  // ---- hyperliquid
  const hlRow = q<{ px: string; time_ms: number; observed_at_ms: number }>(db, "SELECT px, time_ms, observed_at_ms FROM hl_trades ORDER BY time_ms DESC LIMIT 1");
  const hlAge = hlRow ? Math.max(0, Math.round((now - hlRow.time_ms) / 1000)) : null;
  const hlPx = hlRow ? Number(hlRow.px) : null;
  const hl: MonitorData["hl"] = {
    px: hlRow?.px ?? null, ageS: hlAge, time: hlRow ? new Date(hlRow.time_ms).toISOString().slice(11, 19) + "Z" : null,
    stale: hlAge === null ? "N/A" : hlAge * 1000 >= cfg.haltHlStaleMs ? "HALT" : hlAge * 1000 >= cfg.hlStaleMs ? "STALE" : "OK",
    vsRefBps: hlPx && contestD.ref ? +bps(hlPx, Number(contestD.ref)).toFixed(1) : null,
    vsCloseBps: hlPx && contestD.close ? +bps(hlPx, Number(contestD.close)).toFixed(1) : null,
    feedAgeS: (() => { const v = q<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'hl_feed_ok_at'")?.value; return v ? Math.max(0, Math.round((now - Number(v)) / 1000)) : null; })(),
  };
  // Feed status follows FEED health (last successful poll), exactly as the safety halt does; an old last trade is only information.
  hl.stale = hl.feedAgeS === null ? "N/A" : hl.feedAgeS * 1000 >= cfg.haltHlStaleMs ? "HALT" : hl.feedAgeS * 1000 >= cfg.hlStaleMs ? "STALE" : "OK";

  // ---- keys
  const byRows = qa<{ status: string; n: number }>(exec, "SELECT status, COUNT(*) n FROM keys GROUP BY status");
  const by = Object.fromEntries(KEY_STATUSES.map((s) => [s, byRows.find((r) => r.status === s)?.n ?? 0]));
  const total = byRows.reduce((a, r) => a + r.n, 0);
  const fakeN = q<{ n: number }>(exec, "SELECT COUNT(*) n FROM keys WHERE fake = 1")?.n ?? 0;
  const keys: MonitorData["keys"] = { total, by, kind: total === 0 ? "N/A" : fakeN === total ? "FAKE" : fakeN === 0 ? "REAL" : "N/A" };

  // ---- positions (latest snapshot of the book; only open keys are snapshotted)
  const book = live ? "live" : "paper";
  const pSweep = q<{ m: number | null }>(exec, "SELECT MAX(n) m FROM positions WHERE book = ?", book)?.m ?? null;
  const prow0 = pSweep === null ? [] : qa<{ key_id: string; cash: string; position: string; fees: string; value: string | null; mark: string | null; entry_px: string | null }>(exec,
    `SELECT p.key_id, p.cash, p.position, p.fees, p.value, p.mark, k.entry_px FROM positions p LEFT JOIN keys k ON k.id = p.key_id WHERE p.n = ? AND p.book = ?`, pSweep, book);
  // The service snapshots the book only on sweeps where something settles: re-mark it at the latest close
  // (an open position's value is linear in the mark: value(m) = value(m0) + position * (m - m0)).
  const markRow = q<{ n: number; ref_px: string }>(db, "SELECT n, ref_px FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n DESC LIMIT 1");
  const prow = prow0.map((r) => (r.value !== null && r.mark !== null && markRow
    ? { ...r, value: String(Number(r.value) + Number(r.position) * (Number(markRow.ref_px) - Number(r.mark))) } : r));
  const longs = prow.filter((r) => Number(r.position) > 0);
  const shorts = prow.filter((r) => Number(r.position) < 0);
  const sum = (xs: number[]) => +xs.reduce((a, b) => a + b, 0).toFixed(2);
  const scored = prow.map((r) => ({ id: r.key_id, side: Number(r.position) > 0 ? "LONG" : "SHORT", entry: r.entry_px, qty: Math.abs(Number(r.position)),
    score: +((Number(r.value ?? 10_000) - 10_000).toFixed(2)) })).sort((a, b) => b.score - a.score);
  const positions: MonitorData["positions"] = {
    sweep: pSweep, markSweep: markRow && pSweep !== null ? markRow.n : null, mark: markRow && pSweep !== null ? markRow.ref_px : null, long: exec ? longs.length : null, short: exec ? shorts.length : null, flat: exec && total ? total - longs.length - shorts.length : null,
    longQty: exec ? sum(longs.map((r) => Number(r.position))) : null, shortQty: exec ? sum(shorts.map((r) => -Number(r.position))) : null,
    cash: prow.length ? sum(prow.map((r) => Number(r.cash))) : null,
    collateral: prow.length && prow.every((r) => r.entry_px) ? sum(prow.map((r) => Math.abs(Number(r.position)) * Number(r.entry_px))) : null,
    fees: prow.length ? sum(prow.map((r) => Number(r.fees))) : null, realized: null,
    markPnl: prow.length ? sum(scored.map((s) => s.score)) : null, top: scored.slice(0, 5),
  };

  // ---- leaderboard
  // The referee's pnl list is valued at ITS mark (= the global price, checked by L1), not at the close: our keys are
  // re-valued at that same mark before comparing, otherwise the rank compares two different prices.
  const lb = q<{ n: number; pnl_top: string; mark: string | null }>(db, "SELECT n, pnl_top, mark FROM sweeps WHERE pnl_top IS NOT NULL ORDER BY n DESC LIMIT 1");
  const globalTop = lb ? safe(() => JSON.parse(lb.pnl_top) as [string, string][], []) : [];
  const refMark = lb?.mark ?? null;
  const atRef = prow0.filter((r) => r.value !== null && r.mark !== null && refMark !== null)
    .map((r) => ({ id: r.key_id, score: +((Number(r.value) + Number(r.position) * (Number(refMark) - Number(r.mark)) - 10_000).toFixed(2)) }))
    .sort((a, b) => b.score - a.score);
  let rank = "N/A";
  if (live && globalTop.length) {
    const ours = new Set(qa<{ did: string }>(exec, "SELECT did FROM keys WHERE fake = 0").map((r) => r.did));
    const i = globalTop.findIndex(([d]) => ours.has(d));
    if (i >= 0) rank = `#${i + 1} (listed)`;
    else if (atRef.length) {
      const above = globalTop.filter(([, sc]) => Number(sc) > atRef[0].score).length;
      rank = above < globalTop.length ? `≈#${above + 1} (${atRef[0].id} ${signed(atRef[0].score, 2)})` : `below #${globalTop.length} (need > ${globalTop[globalTop.length - 1][1]})`;
    }
  }
  const leaderboard: MonitorData["leaderboard"] = {
    sweep: lb?.n ?? null, mark: refMark, global: globalTop.slice(0, 3).map(([d, s]) => ({ who: `…${d.slice(-8)}`, score: s })),
    ours: (atRef.length ? atRef : scored).slice(0, 3).map((s) => ({ id: s.id, score: s.score })), rank: live ? rank : "N/A (paper keys are not in the game)",
  };

  // ---- strategy K
  const st = safe(() => JSON.parse(q<{ json: string }>(db, "SELECT json FROM strategy_state WHERE name = 'K'")?.json ?? "null") as { lo: number | null; hi: number | null; nextPair: number } | null, null);
  const lastTrig = q<{ sweep: number; trigger: string; decision: string; policy: string | null }>(db, "SELECT sweep, trigger, decision, policy FROM strategy_triggers ORDER BY id DESC LIMIT 1");
  const est = q<{ used: string | null }>(db, "SELECT used FROM estimates ORDER BY n DESC LIMIT 1");
  const x = cfg.strategy.threshold;
  const haltsRaw = q<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'halts'")?.value;
  const halts = safe(() => Object.values(JSON.parse(haltsRaw ?? "{}") as Record<string, { kind: string; severity: string; reason: string; code: string }>), []);
  const stale = contestD.lastSweep !== null && hlPx && contestD.close
    ? decideStale(cfg.stalePolicy, { ageS: contestD.ageS, delayMin: contestD.refereeDelayMin ?? 0, divergenceBps: Math.abs(bps(hlPx, Number(contestD.close))), refEstimated: false })
    : null;
  const pairs = Math.floor(cfg.strategy.keyCount / 2);
  const strategy: MonitorData["strategy"] = {
    status: !running ? "STOPPED" : halts.length ? "HALTED" : (h?.strategy ?? "running").toUpperCase(),
    threshold: x, lo: st?.lo ?? null, hi: st?.hi ?? null,
    nextLo: st?.lo ? +(st.lo * (1 - x)).toFixed(2) : null, nextHi: st?.hi ? +(st.hi * (1 + x)).toFixed(2) : null,
    pairsUsed: st ? st.nextPair : null, pairsUnused: st ? Math.max(0, pairs - st.nextPair) : null,
    lastTrigger: lastTrig ? `${lastTrig.trigger} (${lastTrig.decision})` : null, lastTriggerSweep: lastTrig?.sweep ?? null,
    estimator: est?.used ?? cfg.estimator, stale: stale?.decision ?? null, staleReason: stale?.reason ?? null,
  };

  // ---- trades (paper: simulated intents; live: the trades table)
  let trades: MonitorData["trades"];
  if (!live) {
    const c = q<{ total: number; settled: number; void: number; pending: number; unknown: number }>(exec, `SELECT COUNT(*) total,
      SUM(outcome = 'settled') settled, SUM(outcome = 'void') void, SUM(risk_status = 'OK' AND outcome IS NULL) pending,
      SUM(outcome IS NOT NULL AND outcome NOT IN ('settled','void')) unknown FROM intents`);
    const recent = qa<{ trade_id: string | null; maker_id: string; taker_id: string; favored: string; qty: string; px: string; sweep: number; outcome: string | null; risk_status: string; mf: string | null; tf: string | null }>(exec,
      `SELECT trade_id, maker_id, taker_id, favored, qty, px, sweep, outcome, risk_status, COALESCE(actual_maker_fee, expected_maker_fee) mf,
       COALESCE(actual_taker_fee, expected_taker_fee) tf FROM intents ORDER BY created_at DESC LIMIT 5`);
    trades = { simulated: true, total: c?.total ?? null, settled: c?.settled ?? (c ? 0 : null), void: c?.void ?? (c ? 0 : null), pending: c?.pending ?? (c ? 0 : null), unknown: c?.unknown ?? (c ? 0 : null),
      recent: recent.map((r) => ({ id: (r.trade_id ?? "-").slice(0, 8), maker: r.maker_id, taker: r.taker_id, side: (r.favored ?? "").toUpperCase(), qty: r.qty, px: r.px, sweep: r.sweep,
        status: (r.outcome ?? (r.risk_status === "OK" ? "pending" : `rejected`)).toUpperCase(), fee: r.mf && r.tf ? (Number(r.mf) + Number(r.tf)).toFixed(2) : null })) };
  } else {
    // Live: the LiveExecutor's journal (one row per Strategy K intent), states as the executor records them.
    const c = q<{ total: number; settled: number; void: number; pending: number; unknown: number }>(exec, `SELECT COUNT(*) total,
      SUM(state = 'SETTLED') settled, SUM(state IN ('VOID','NOT_POSTED','FAILED','LATE')) void,
      SUM(state IN ('CREATED','SIGNED','POSTING','POSTED','CONFIRMED')) pending, SUM(state = 'UNKNOWN') unknown FROM live_trades`);
    const recent = qa<{ trade_id: string; maker_id: string; taker_id: string; favored: string | null; qty: string | null; px: string | null; sweep: number; state: string; mf: string | null; tf: string | null }>(exec,
      `SELECT l.trade_id, l.maker_id, l.taker_id, i.favored, i.qty, i.px, l.sweep, l.state, COALESCE(i.actual_maker_fee, i.expected_maker_fee) mf,
       COALESCE(i.actual_taker_fee, i.expected_taker_fee) tf FROM live_trades l LEFT JOIN intents i ON i.intent_id = l.intent_id ORDER BY l.created_at DESC LIMIT 5`);
    trades = { simulated: false, total: c?.total ?? null, settled: c?.settled ?? (c ? 0 : null), void: c?.void ?? (c ? 0 : null), pending: c?.pending ?? (c ? 0 : null), unknown: c?.unknown ?? (c ? 0 : null),
      recent: recent.map((r) => ({ id: r.trade_id.slice(0, 8), maker: r.maker_id, taker: r.taker_id, side: (r.favored ?? "").toUpperCase(), qty: r.qty ?? "-", px: r.px ?? "-", sweep: r.sweep,
        status: r.state, fee: r.mf && r.tf ? (Number(r.mf) + Number(r.tf)).toFixed(2) : null })) };
  }

  // ---- security
  const pendingWrites = q<{ n: number }>(exec, "SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')")?.n ?? null;
  // Refusals that name the nonce (409 "nonce must exceed", ...). A 2xx receipt also carries a "nonce" field: not an error.
  const nonceErrors = q<{ n: number }>(exec, `SELECT COUNT(*) n FROM write_attempts WHERE (http_status IS NULL OR http_status >= 400)
    AND (response LIKE '%nonce%' OR error LIKE '%nonce%')`)?.n ?? null;
  const security: MonitorData["security"] = {
    executor: running ? h?.executor ?? (live ? "live" : "paper") : "stopped", writes: live && writerState(cfg).armed ? "ENABLED" : "DISABLED",
    halted: db ? halts.length > 0 : null, safeMode: !db ? "N/A" : halts.length ? "YES" : "NO",
    haltReason: halts.length ? halts.map((x2) => `${x2.kind}${x2.severity === "grave" ? ` [grave, unhalt --code ${x2.code}]` : ""}: ${x2.reason}`).join(" | ") : null,
    pendingWrites, unresolved: trades.pending, nonceErrors,
  };

  // ---- reconciliation
  const l1 = q<{ status: string; n: number | null }>(db, "SELECT status, n FROM reconcile WHERE level = 'L1-referee' ORDER BY id DESC LIMIT 1");
  const l2 = q<{ status: string; level: string }>(db, "SELECT status, level FROM reconcile WHERE level LIKE 'L2%' ORDER BY id DESC LIMIT 1");
  const mm = q<{ n: number }>(db, "SELECT COUNT(*) n FROM reconcile WHERE status <> 'OK'");
  const startIso = sd?.since ? new Date(sd.since).toISOString() : h ? new Date(now - h.process.uptime_s * 1000).toISOString() : null;
  const mmNow = startIso ? q<{ n: number }>(db, "SELECT COUNT(*) n FROM reconcile WHERE status <> 'OK' AND at >= ?", startIso) : undefined;
  const lastMm = q<{ n: number | null; level: string; at: string }>(db, "SELECT n, level, at FROM reconcile WHERE status <> 'OK' ORDER BY id DESC LIMIT 1");
  const reconcile: MonitorData["reconcile"] = {
    l1: l1?.status ?? null, l1Sweep: l1?.n ?? null, l2: l2?.status ?? null, mismatches: mm?.n ?? null, sinceStart: mmNow?.n ?? null,
    lastMismatch: lastMm ? `${lastMm.level} @${lastMm.n ?? "-"} ${lastMm.at.slice(0, 16).replace("T", " ")}` : null,
  };

  // ---- errors
  const errors: MonitorData["errors"] = {
    reconnects: h?.counters.reconnects ?? null, timeouts: h?.counters.timeouts ?? null, http503: safe(() => count503(cfg.logDir, now), null),
    alerts24h: q<{ n: number }>(db, "SELECT COUNT(*) n FROM alerts WHERE at > ?", new Date(now - 86_400_000).toISOString())?.n ?? null,
    alertsSinceStart: startIso ? q<{ n: number }>(db, "SELECT COUNT(*) n FROM alerts WHERE at >= ?", startIso)?.n ?? null : null,
    lastAlerts: qa<{ at: string; severity: string; message: string }>(db, "SELECT at, severity, message FROM alerts WHERE severity <> 'info' ORDER BY id DESC LIMIT 3"),
  };

  // ---- activity
  const hlObs = q<{ m: number | null }>(db, "SELECT MAX(observed_at_ms) m FROM hl_trades")?.m ?? null;
  const decided = q<{ t: string | null }>(db, "SELECT MAX(decided_at) t FROM estimates")?.t ?? null;
  const mt = (p: string) => safe(() => statSync(p).mtimeMs, 0);
  const lastWrite = Math.max(mt(cfg.dbPath), mt(cfg.dbPath + "-wal"));
  const activity: MonitorData["activity"] = {
    refereeS: secs(lastRaw), hlS: hlObs ? Math.max(0, Math.round((now - hlObs) / 1000)) : null, strategyS: secs(decided),
    dbWriteS: lastWrite ? Math.max(0, Math.round((now - lastWrite) / 1000)) : null,
    technocoreWriteS: null, journalS: null, nonceReconcileS: null, backupVerifyS: null,
  };

  // ---- live-only operational state (same sources as the service and the gate; see monitor-live.ts)
  const liveD: MonitorData["live"] = live && exec ? await collectLive(exec, cfg, contest, now, src.ntp).catch(() => null) : null;
  const sAgo = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null);
  activity.technocoreWriteS = sAgo(liveD?.lastTechnocoreWrite);
  activity.journalS = sAgo(liveD?.journal.lastTransition);
  activity.nonceReconcileS = sAgo(liveD?.nonces.lastReconcile);
  activity.backupVerifyS = sAgo(liveD?.lastBackupVerify);
  const w = writerState(cfg);
  const env: MonitorData["env"] = {
    dataDir: cfg.dataDir, db: cfg.dbPath, node: process.version,
    sqlite: safe(() => (JSON.parse(readFileSync(join(process.cwd(), "node_modules/better-sqlite3/package.json"), "utf8")) as { version: string }).version, "N/A"),
    writerArmed: w.armed, writerReason: w.reason, policy: cfg.confirmationPolicy, estimator: cfg.estimator,
  };

  safe(() => db?.close(), undefined);
  if (exec && exec !== db) safe(() => exec.close(), undefined);
  return { at: now, host: hostname(), mode: cfg.mode, version: (src.version ?? readVersion)(), service, contest: contestD, hl, keys, positions, leaderboard, strategy, trades, security, reconcile, errors, activity, live: liveD, env, processStart: startIso };
}

// ------------------------------------------------------------------ render

export interface Paint { ok(s: string): string; warn(s: string): string; err(s: string): string; paper(s: string): string; live(s: string): string; bold(s: string): string; dim(s: string): string }

export function paint(color: boolean): Paint {
  const w = (a: string, b = "0") => (s: string) => (color ? `\x1b[${a}m${s}\x1b[${b}m` : s);
  return { ok: w("32"), warn: w("33"), err: w("1;31"), paper: w("1;36"), live: w("1;97;41"), bold: w("1"), dim: w("2") };
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const NA = "N/A";
const v = (x: unknown, suffix = "") => (x === null || x === undefined || x === "" ? NA : `${x}${suffix}`);
const signed = (x: number | null, d = 1, suffix = "") => (x === null ? NA : `${x >= 0 ? "+" : ""}${x.toFixed(d)}${suffix}`);
export function dur(s: number | null): string {
  if (s === null) return NA;
  const d = Math.floor(s / 86_400);
  const hh = String(Math.floor((s % 86_400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return `${d ? `${d}d ` : ""}${hh}:${mm}:${ss}`;
}
export function ago(s: number | null): string {
  if (s === null) return NA;
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s ago`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ago`;
}

type Block = string[];

export function render(d: MonitorData, opts: { color: boolean; width: number; compact?: boolean }): string {
  const p = paint(opts.color);
  const LW = 19;
  const row = (label: string, value: string) => `${label.padEnd(LW)}${value}`;
  const state = (s: string) => (/^(OK|RUNNING|NO|DISABLED|TRADE|PAPER)$/.test(s) ? p.ok(s) : /^(DOWN|ERROR|HALTED|HALT|YES|STOPPED|HALT_NEW_ENTRIES)$/.test(s) ? p.err(s) : /^(N\/A|UNKNOWN)$/.test(s) ? p.dim(s) : p.warn(s));
  const live = d.mode === "live";
  const blocks: Block[] = [];

  const E = d.env;
  blocks.push([p.bold("ENVIRONMENT"),
    row("MODE", live ? p.live(" LIVE ") : p.paper("PAPER")), row("DATA DIR", E.dataDir.slice(-26)), row("DB", E.db.split("/").pop() ?? E.db),
    row("RUNTIME", E.node), row("better-sqlite3", E.sqlite),
    row("WRITER", live ? (E.writerArmed ? p.err("CONNECTED · ARMED") : p.ok("CONNECTED · DISARMED")) : p.ok("NONE (paper)")),
    ...(live && !E.writerArmed ? [p.dim(`  ${E.writerReason}`.slice(0, 44))] : []),
    row("CONFIRM POLICY", E.policy), row("ESTIMATOR", E.estimator),
  ]);

  blocks.push([p.bold("SERVICE"),
    row("service", d.service.state === "OK" ? p.ok("OK") : p.err(d.service.state === "DOWN" ? "SERVICE DOWN" : d.service.state)),
    row("systemd", v(d.service.systemd)),
    row("mode", live ? p.live(" LIVE ") : p.paper("PAPER")),
    row("writes", d.security.writes === "DISABLED" ? p.ok("DISABLED") : p.err("ENABLED")),
    row("PID", v(d.service.pid)), row("uptime", dur(d.service.uptimeS)),
    row("memory RSS", v(d.service.rssMb, " MB")), row("CPU", v(d.service.cpuPct, " %")), row("restarts", v(d.service.restarts)),
    row("lock", `${state(d.service.lock)} ${p.dim(d.service.lockDetail)}`),
    row("DB", d.service.db === "OK" ? p.ok("OK") : `${p.err("ERROR")} ${p.dim((d.service.dbError ?? "").slice(0, 40))}`),
    row("disk free", v(d.service.diskFreeMb, " MB")), row("SQLite", `${v(d.service.dbSizeMb, " MB")} ${p.dim(`wal ${v(d.service.walMb, " MB")}`)}`),
    row("process start", v(d.processStart?.slice(0, 19).replace("T", " "))),
  ]);

  const c = d.contest;
  const refStale = c.ageS !== null && c.ageS >= 300;
  const lagWarn = (c.refereeDelayMin ?? 0) >= 15;
  blocks.push([p.bold("CONTEST"),
    row("season", c.season), row("sweep (clock)", v(c.currentSweep)),
    row("last received", c.lastSweep === null ? NA : c.currentSweep !== null && c.currentSweep - c.lastSweep > 1 ? p.warn(`${c.lastSweep} (${c.currentSweep - c.lastSweep} behind)`) : p.ok(String(c.lastSweep))),
    row("referee update", ago(c.secSinceReferee)),
    row("referee delay", c.refereeDelayMin === null ? NA : lagWarn ? p.warn(`${c.refereeDelayMin} min`) : `${c.refereeDelayMin} min`),
    row("age_s", c.ageS === null ? NA : refStale ? p.err(`${c.ageS}s STALE`) : `${c.ageS}s`),
    row(`REF (${v(c.refSweep)})`, v(c.ref)), row(`CLOSE (${v(c.lastSweep)})`, v(c.close)), row("global", v(c.global)),
  ]);

  const hl = d.hl;
  blocks.push([p.bold("HYPERLIQUID xyz:NVDA"),
    row("NVDA", v(hl.px)),
    row("last_trade_age", hl.ageS === null ? NA : `${hl.ageS}s ${p.dim("(a quiet market is normal)")}`),
    row("feed_health_age", hl.feedAgeS === null ? p.dim("N/A (service view)") : `${hl.feedAgeS}s`),
    row("feed status", hl.stale === "OK" ? p.ok("OK") : hl.stale === "STALE" ? p.warn("STALE") : hl.stale === "HALT" ? p.err("DOWN (halt)") : NA),
    row("trade time", v(hl.time)), row("HL vs REF", signed(hl.vsRefBps, 1, " bps")), row("HL vs CLOSE", signed(hl.vsCloseBps, 1, " bps")),
  ]);

  const k = d.keys;
  blocks.push([p.bold("KEYS"),
    row("total", k.total === 0 ? p.warn("0 (no keys)") : `${k.total} ${k.kind === "FAKE" ? p.paper("FAKE KEYS") : k.kind === "REAL" ? p.live(" REAL KEYS ") : ""}`),
    ...KEY_STATUSES.map((s) => row(`  ${s}`, s === "ERROR" && (k.by[s] ?? 0) > 0 ? p.err(String(k.by[s])) : String(k.by[s] ?? 0))),
  ]);

  const ps = d.positions;
  blocks.push([p.bold(`POSITIONS${d.trades.simulated ? " (paper)" : ""}`) + p.dim(ps.sweep !== null ? ` @${ps.sweep}${ps.mark !== null && ps.markSweep !== ps.sweep ? ` marked @${ps.markSweep} ${ps.mark}` : ""}` : ""),
    row("long keys", v(ps.long)), row("short keys", v(ps.short)), row("flat keys", v(ps.flat)),
    row("long qty", v(ps.longQty)), row("short qty", v(ps.shortQty)),
    row("cash (open)", v(ps.cash)), row("collateral", v(ps.collateral)), row("fees", v(ps.fees)),
    row("realized pnl", v(ps.realized)), row("mark pnl", signed(ps.markPnl, 2)),
    p.dim("top keys  side   entry   qty   score"),
    ...(ps.top.length ? ps.top.map((t) => `${t.id.padEnd(9)} ${t.side.padEnd(6)} ${v(t.entry).padEnd(7)} ${String(t.qty).padEnd(5)} ${signed(t.score, 2)}`) : [p.dim("(no open position)")]),
  ]);

  const lb = d.leaderboard;
  blocks.push([p.bold("LEADERBOARD") + p.dim(lb.sweep !== null ? ` @${lb.sweep}${lb.mark ? ` mark ${lb.mark} (global)` : ""}` : ""),
    p.dim("GLOBAL"), ...(lb.global.length ? lb.global.map((g, i) => row(`#${i + 1} ${g.who}`, `+${g.score}`)) : [NA]),
    p.dim(lb.mark ? `OUR TOP (at the same mark ${lb.mark})` : "OUR TOP"), ...(lb.ours.length ? lb.ours.map((o, i) => row(`#${i + 1} ${o.id}`, signed(o.score, 2))) : [NA]),
    row("our rank", lb.rank),
  ]);

  const s = d.strategy;
  blocks.push([p.bold(`STRATEGY K ${p.dim(live ? "(live strategy state)" : "(paper strategy state)")}`),
    row("strategy", state(s.status)), row("threshold", `${(s.threshold * 100).toFixed(2)}%`),
    row("last low", v(s.lo)), row("next low", v(s.nextLo)), row("last high", v(s.hi)), row("next high", v(s.nextHi)),
    row("pairs used", v(s.pairsUsed)), row("pairs unused", v(s.pairsUnused)),
    row("last trigger", v(s.lastTrigger)), row("trigger sweep", v(s.lastTriggerSweep)),
    row("estimated_close", v(s.estimator)), row("stale policy", s.stale ? state(s.stale) : NA),
    ...(s.stale && s.stale !== "TRADE" ? [p.dim(`  ${s.staleReason}`)] : []),
  ]);

  const t = d.trades;
  const tradeStatus = (st: string) => (st === "SETTLED" ? p.ok(st) : /VOID|REJECTED|NEVER/.test(st) ? p.warn(st) : st === "PENDING" || st === "POSTED" || st === "SIGNED" || st === "PLANNED" ? p.warn(st) : p.err(st));
  blocks.push([p.bold(t.simulated ? "TRADES (SIMULATED)" : "TRADES (REAL)"),
    row("total intents", v(t.total)), row("settled", v(t.settled)), row("void", (t.void ?? 0) > 0 ? p.warn(String(t.void)) : v(t.void)),
    row("pending", (t.pending ?? 0) > 0 ? p.warn(String(t.pending)) : v(t.pending)), row("unknown", (t.unknown ?? 0) > 0 ? p.err(String(t.unknown)) : v(t.unknown)),
    ...(t.recent.length ? [p.dim("LAST TRADE"), `${t.recent[0].maker} -> ${t.recent[0].taker}  ${t.recent[0].id}`,
      `${t.recent[0].side} ${t.recent[0].qty} @ ${t.recent[0].px}  #${t.recent[0].sweep}`, `${tradeStatus(t.recent[0].status)} fee ${v(t.recent[0].fee)}`,
      p.dim("id    pair        side  qty    px      #   status"),
      ...t.recent.slice(0, 5).map((r) => `${r.id.slice(0, 5)} ${`${r.maker}>${r.taker}`.padEnd(11)} ${r.side.slice(0, 5).padEnd(5)} ${r.qty.padEnd(6)} ${r.px.padEnd(7)} ${String(r.sweep).padEnd(3)} ${tradeStatus(r.status)}`)] : [p.dim("(no trade yet)")]),
  ]);

  const sec = d.security;
  blocks.push([p.bold("SAFETY"),
    row("executor", v(sec.executor)), row("writes", sec.writes === "DISABLED" ? p.ok("DISABLED") : p.err("ENABLED")),
    row("execution halted", sec.halted === null ? NA : sec.halted ? p.err("YES") : p.ok("NO")),
    row("safe mode", state(sec.safeMode)), row("halt reason", sec.haltReason ? p.err(sec.haltReason) : "-"),
    row("pending writes", (sec.pendingWrites ?? 0) > 0 ? p.warn(String(sec.pendingWrites)) : v(sec.pendingWrites)),
    row("unresolved trades", v(sec.unresolved)), row("nonce errors", (sec.nonceErrors ?? 0) > 0 ? p.err(String(sec.nonceErrors)) : v(sec.nonceErrors)),
  ]);

  const r = d.reconcile;
  blocks.push([p.bold("RECONCILE"),
    row("L1", r.l1 === null ? NA : `${state(r.l1 === "OK" ? "OK" : "ERROR")}${r.l1Sweep !== null ? ` @${r.l1Sweep}` : ""}`),
    row("L2", r.l2 === null ? NA : state(r.l2 === "OK" ? "OK" : "ERROR")),
    row("mismatches (run)", r.sinceStart === null ? NA : r.sinceStart > 0 ? p.err(String(r.sinceStart)) : p.ok("0")),
    row("mismatches (all)", p.dim(v(r.mismatches))), row("last mismatch", p.dim(v(r.lastMismatch))),
  ]);

  const e = d.errors;
  blocks.push([p.bold("ERRORS"),
    row("reconnects", v(e.reconnects)), row("timeouts", v(e.timeouts)), row("HTTP 503 today", v(e.http503)),
    row("alerts (run)", (e.alertsSinceStart ?? 0) > 0 ? p.warn(String(e.alertsSinceStart)) : v(e.alertsSinceStart)), row("alerts 24h (all)", p.dim(v(e.alerts24h))),
    ...e.lastAlerts.map((a) => `${p.dim(a.at.slice(5, 16).replace("T", " "))} ${a.severity === "critical" ? p.err(a.severity) : p.warn(a.severity)} ${a.message.slice(0, 60)}`),
  ]);

  if (d.live) {
    const L = d.live;
    const okv = (b: boolean | null, t: string, f?: string) => (b === null ? NA : b ? p.ok(t) : p.err(f ?? t));
    blocks.push([p.bold("KEY CLASSES (REAL KEYS)"),
      row("ADMIN", `${L.classes.admin.length} ${p.dim(L.classes.admin.join(" "))}`),
      row("STAGING", `${L.classes.staging.length} ${p.dim(L.classes.staging.join(" "))}`),
      row("STRATEGY", `${L.classes.strategy.count} ${p.dim(L.classes.strategy.first ? `${L.classes.strategy.first}..${L.classes.strategy.last}` : "")}`),
      row("strategy pairs", `${L.classes.strategyPairs} ${p.dim("(no staging/admin)")}`),
      ...KEY_FLAGS.map((f) => row(`  ${f}`, f === "ERROR" && L.flags[f] > 0 ? p.err(String(L.flags[f])) : String(L.flags[f]))),
    ]);
    blocks.push([p.bold("BACKUP"),
      row("backup age", okv(L.backup.ok, "OK", "FAIL")), row("latest backup", v(L.backup.latestAt)), row("restore verify", okv(L.backup.restoreOk, "OK", `FAIL ${L.backup.detail.slice(0, 26)}`)),
      row("keys newer", L.backup.keysNewer ? p.err("YES") : p.ok("NO")), row("plaintext backup", L.backup.plaintext ? p.err("YES") : p.ok("NO")),
    ]);
    blocks.push([p.bold("ROOM"),
      row("room", v(L.room.name)), row("status", L.room.status === "READY" ? p.ok("READY") : p.warn(L.room.status)),
      row("exists", L.room.exists === null ? NA : L.room.exists ? p.ok("YES") : p.err("NO")), row("owner", v(L.room.owner)),
      row("writers", `${v(L.room.allowCount)} allowed / ${L.room.expectedWriters} expected`), row("generation", v(L.room.generation)),
      row("last refresh", v(L.room.lastRefresh?.slice(0, 16))), row("last check", v(L.room.checkedAt?.slice(11, 19))),
      row("room missing", L.room.missing ? p.err(`YES ${L.room.why ?? ""}`.slice(0, 40)) : p.ok("NO")),
    ]);
    blocks.push([p.bold("NONCES"),
      row("scopes", String(L.nonces.scopes)), row("status", L.nonces.status === "OK" ? p.ok("OK") : p.err(L.nonces.status.slice(0, 30))),
      row("server/local", L.nonces.mismatch === null ? p.dim("N/A (at service start)") : L.nonces.mismatch === "0" ? p.ok("0 mismatches") : p.err(L.nonces.mismatch.slice(0, 30))),
      row("last reconcile", v(L.nonces.lastReconcile?.slice(0, 16))),
    ]);
    blocks.push([p.bold("LIVE JOURNAL"),
      ...JOURNAL_STATES.map((s) => row(`  ${s}`, s === "UNKNOWN" && L.journal.counts[s] > 0 ? p.err(String(L.journal.counts[s])) : String(L.journal.counts[s]))),
      row("pending", L.journal.pending > 0 ? p.warn(String(L.journal.pending)) : "0"), row("unknown", L.journal.unknown > 0 ? p.err(String(L.journal.unknown)) : p.ok("0")),
      row("last trade", `${v(L.journal.lastId)} ${v(L.journal.lastState)}`), row("last POST", v(L.journal.lastPost?.slice(11, 19))), row("last referee", v(L.journal.lastReferee?.slice(11, 19))),
    ]);
    blocks.push([p.bold("CLOCK"),
      row("system time", L.clock.system.slice(0, 19).replace("T", " ")), row("NTP", L.clock.ntp === null ? NA : L.clock.ntp ? p.ok("YES") : p.err("NO (live FAIL)")), row("skew", v(L.clock.skew)),
    ]);
    const bad = [...L.readiness.local, ...L.readiness.network].filter((r) => !r.ok);
    const pick = (name: string) => [...L.readiness.local, ...L.readiness.network].find((r) => r.name === name);
    const rr = (label: string, ...names: string[]) => { const rs = names.map(pick).filter(Boolean) as { ok: boolean; value: string }[]; return row(label, !rs.length ? p.dim("N/A") : rs.every((r) => r.ok) ? p.ok("OK") : p.err(`FAIL ${rs.find((r) => !r.ok)!.value.slice(0, 24)}`)); };
    blocks.push([p.bold("LIVE READINESS"),
      rr("writer", "writer"), rr("keys", "admin key", "staging keys", "strategy keys", "key dir perms"), rr("backup", "encrypted backup", "restore verification", "no plaintext key backup"),
      rr("room", "room state", "room on server", "room generation"), rr("nonces", "nonce store", "nonce reconciliation", "note nonce (room-nonce)"),
      rr("referee", "referee", "referee seed"), rr("Hyperliquid", "Hyperliquid feed"), rr("clock", "NTP", "clock skew"), rr("pending writes", "pending writes"),
      rr("unknown trades", "unknown trades"), rr("safe mode", "not halted"),
      p.dim(`network rows as of ${L.readiness.networkAt ? L.readiness.networkAt.slice(0, 16) : "never (run live-check)"}`),
      L.readiness.pass ? p.ok("LIVE READINESS: PASS") : p.err(`LIVE READINESS: FAIL (${bad.length})`),
      ...bad.slice(0, 3).map((r) => p.dim(`  ${r.name}: ${r.value}`.slice(0, 44))),
    ]);
  }

  const a = d.activity;
  const fresh = (x: number | null, warnS: number) => (x === null ? NA : x > warnS * 3 ? p.err(ago(x)) : x > warnS ? p.warn(ago(x)) : ago(x));
  blocks.push([p.bold("ACTIVITY"),
    row("referee event", fresh(a.refereeS, 120)), row("Hyperliquid event", fresh(a.hlS, 60)), row("strategy eval", fresh(a.strategyS, 420)), row("DB write", fresh(a.dbWriteS, 60)),
    ...(live ? [row("technocore write", v(a.technocoreWriteS === null ? null : ago(a.technocoreWriteS))), row("journal change", v(a.journalS === null ? null : ago(a.journalS))),
      row("nonce reconcile", v(a.nonceReconcileS === null ? null : ago(a.nonceReconcileS))), row("backup verify", v(a.backupVerifyS === null ? null : ago(a.backupVerifyS)))] : []),
  ]);

  if (opts.compact) {
    // One screen: what matters while trading. The live detail blocks collapse into one LIVE block.
    const keep = /^(CONTEST|POSITIONS|LEADERBOARD|STRATEGY K|TRADES|SAFETY|ERRORS|RECONCILE)/;
    const kept = blocks.filter((b) => keep.test(stripAnsi(b[0])));
    if (d.live) {
      const L = d.live;
      const J = L.journal.counts;
      const bad = [...L.readiness.local, ...L.readiness.network].filter((x) => !x.ok);
      kept.push([p.bold("LIVE"),
        row("readiness", L.readiness.pass ? p.ok("PASS") : p.err(`FAIL ${bad[0]?.name ?? ""}`.slice(0, 26))),
        row("keys READY", `${L.flags.READY}/${L.classes.admin.length + L.classes.staging.length + L.classes.strategy.count}${L.flags.ERROR ? p.err(` ERROR ${L.flags.ERROR}`) : ""}`),
        row("room", `${L.room.status === "READY" ? p.ok("READY") : p.warn(L.room.status)} ${v(L.room.allowCount)}/${L.room.expectedWriters} ${L.room.missing ? p.err("MISSING") : ""}`),
        row("nonces", L.nonces.status === "OK" && (L.nonces.mismatch ?? "0") === "0" ? p.ok("OK") : p.err(`${L.nonces.status} ${L.nonces.mismatch ?? ""}`.slice(0, 26))),
        row("backup", L.backup.ok && L.backup.restoreOk && !L.backup.keysNewer ? p.ok("OK") : p.err("CHECK")),
        row("journal", `pend ${L.journal.pending > 0 ? p.warn(String(L.journal.pending)) : "0"} unk ${L.journal.unknown > 0 ? p.err(String(L.journal.unknown)) : "0"} set ${J.SETTLED} void ${J.VOID} n/a ${J.NOT_APPLIED + J.NOT_POSTED}`),
        row("last trade", `${v(L.journal.lastId)} ${v(L.journal.lastState)}`),
        row("last POST", `${v(L.journal.lastPost?.slice(11, 19))} ${p.dim(`ref ${v(L.journal.lastReferee?.slice(11, 19))}`)}`),
        row("clock", `${L.clock.ntp === false ? p.err("NTP NO") : "NTP"} ${v(L.clock.skew).replace(/ \(.*$/, "").replace("skew vs technocore ", "")}`),
      ]);
    }
    blocks.length = 0;
    blocks.push(...kept);
  }

  // ---- header
  const at = new Date(d.at);
  const local = at.toLocaleTimeString("en-GB", { hour12: false });
  const armed = d.env.writerArmed;
  const title = !live ? p.paper("CLOSE CALL — PAPER") : armed ? p.live(" CLOSE CALL — LIVE ") : p.warn("CLOSE CALL — LIVE CANDIDATE");
  const head = [
    `${title}  ${d.host}  pid ${v(d.service.pid)}  up ${dur(d.service.uptimeS)}  ${at.toISOString().slice(0, 19).replace("T", " ")} UTC  ${local} local  ${d.version}`,
    [d.service.state !== "OK" ? p.err("SERVICE DOWN") : "",
      !live ? p.paper("WRITES: DISABLED") + p.dim("  FAKE KEYS · SIMULATED TRADES · nothing is signed or sent")
        : armed ? p.live(" WRITES: ENABLED — REAL KEYS ") : p.ok("WRITES: DISABLED") + p.dim(`  (${d.env.writerReason})`),
      live && d.live && !d.live.readiness.pass ? p.err("LIVE READINESS: FAIL") : live && d.live ? p.ok("LIVE READINESS: PASS") : "",
      sec.halted ? p.err(`HALTED: ${sec.haltReason ?? ""}`.slice(0, 90)) : ""].filter(Boolean).join("   "),
    "",
  ];
  return head.concat(layout(blocks, opts.width)).join("\n");
}

/** Cut to `n` visible characters, keeping escape codes intact (and resetting if any was cut). */
export function clipAnsi(s: string, n: number): string {
  if (stripAnsi(s).length <= n) return s;
  let out = "";
  let vis = 0;
  for (let i = 0; i < s.length && vis < n; ) {
    const m = s.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += s[i++];
    vis++;
  }
  return s.includes("\x1b") ? out + "\x1b[0m" : out;
}

/** Greedy column layout: each block goes to the currently shortest column. */
export function layout(blocks: Block[], width: number): string[] {
  const COL = 46;
  const ncols = Math.max(1, Math.min(4, Math.floor((width + 2) / (COL + 2))));
  if (ncols === 1) return blocks.flatMap((b) => [...b, ""]);
  const cols: string[][] = Array.from({ length: ncols }, () => []);
  for (const b of blocks) {
    const target = cols.reduce((best, c, i) => (c.length < cols[best].length ? i : best), 0);
    cols[target].push(...b, "");
  }
  const h = Math.max(...cols.map((c) => c.length));
  const out: string[] = [];
  for (let i = 0; i < h; i++) {
    out.push(cols.map((c) => {
      const clipped = clipAnsi(c[i] ?? "", COL);
      return clipped + " ".repeat(Math.max(0, COL - stripAnsi(clipped).length));
    }).join("  ").replace(/(?:\s|\x1b\[[0-9;]*m)+$/, (m) => m.replace(/\s/g, "")));
  }
  return out;
}

// ------------------------------------------------------------------ watch

export function useColor(argv: string[], stream: NodeJS.WriteStream = process.stdout): boolean {
  if (argv.includes("--no-color") || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb") return false;
  return argv.includes("--color") || !!stream.isTTY;
}

export async function watch(src: MonitorSources, opts: { intervalS: number; color: boolean; compact?: boolean }): Promise<void> {
  const out = process.stdout;
  let stop = false;
  const restore = () => { if (out.isTTY) out.write("\x1b[?25h\x1b[0m\n"); };
  const onSig = () => { stop = true; restore(); process.exit(0); };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  if (out.isTTY) out.write("\x1b[?25l\x1b[2J");
  let prev: { at: number; cpuNs: number } | null = null;
  while (!stop) {
    const t0 = Date.now();
    let frame: string;
    try {
      const sd = (src.systemd ?? readSystemd)();
      const data = await collect({ ...src, now: undefined, systemd: () => sd, prev });
      if (sd?.cpuNs !== null && sd?.cpuNs !== undefined) prev = { at: data.at, cpuNs: sd.cpuNs };
      frame = render(data, { color: opts.color, width: out.columns || 100, compact: opts.compact }) + `\n\n${opts.color ? "\x1b[2m" : ""}refresh ${opts.intervalS}s · Ctrl+C to quit · read only${opts.color ? "\x1b[0m" : ""}`;
    } catch (e) {
      frame = `CLOSE CALL monitor: could not collect (${(e as Error).message}); retrying`;
    }
    if (out.isTTY) out.write("\x1b[H" + frame.split("\n").map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
    else out.write(frame + "\n\n");
    const wait = Math.max(200, opts.intervalS * 1000 - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}
