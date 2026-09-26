/**
 * The 24/7 loop (observe / paper). One loop, one step at a time, so decisions and settlements never race.
 *
 *   every refereePollMs (2 s just after a boundary): read the 5 referee rooms, store, reconcile L1,
 *                                                     settle paper intents on price posts
 *   every hlPollMs:                                  Hyperliquid recentTrades (read-only)
 *   boundary(n) - decisionLeadMs:                    paper mode decides sweep n -- unless execution is halted
 *   every 30 s:                                       safety checks, heartbeat, health events
 *
 * Safety: referee silence, stale Hyperliquid and low disk raise TRANSIENT halts that clear themselves;
 * a reconciliation mismatch or a database error raises a GRAVE halt (manual unhalt). The observer keeps
 * running under every halt. SIGINT/SIGTERM: finish the current step, close the health server, stop the
 * fold bridges, release the lock.
 */

import { statfsSync } from "node:fs";
import type { Server } from "node:http";
import type { CloseCallConfig } from "./config.js";
import { lastClosedSweep, sweepTime, type Contest } from "./contest.js";
import { Alerts } from "./alerts.js";
import { OfficialFold } from "./fold.js";
import { health, type RuntimeState } from "./health.js";
import { startHealthServer } from "./http.js";
import { HyperliquidObserver } from "./hyperliquid.js";
import { ccLog } from "./logger.js";
import { RefereeObserver } from "./observer.js";
import { foldConfig, PAPER_EXECUTOR, PaperTrader, type TradeExecutor } from "./paper.js";
import type { PricePost } from "./protocol.js";
import { reconcileReferee } from "./reconcile.js";
import { clearTransient, halt, isHalted } from "./safety.js";
import { snapshot } from "./status.js";
import { getMeta, healthEvent, setMeta, type CcDb } from "./store.js";

export interface RunOptions {
  maxMinutes?: number;
  paper: boolean;
  /** Live: the LiveExecutor (built by live/cli-live.ts, the only place that can). Same decision engine as paper. */
  executor?: TradeExecutor & { confirmPosted?: () => Promise<number> };
  /** Live: room upkeep (RoomKeeper.tick: ownership/allow-list/existence check, 5-day refresh, keepalive), every minute. */
  maintenance?: () => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function banner(mode: string): string {
  const word = mode.toUpperCase() + " MODE";
  const line = "#".repeat(72);
  const pad = (s: string) => `###${" ".repeat(Math.max(0, Math.floor((66 - s.length) / 2)))}${s}${" ".repeat(Math.max(0, Math.ceil((66 - s.length) / 2)))}###`;
  const sub = mode === "live" ? "SIGNS AND POSTS REAL MESSAGES" : "NO SIGNING - NO WRITES TO TECHNOCORE - FAKE KEYS";
  return [line, pad(""), pad(`CLOSE CALL  -  ${word}`), pad(sub), pad(""), line].join("\n");
}

export async function runLoop(db: CcDb, cfg: CloseCallConfig, contest: Contest, opts: RunOptions): Promise<void> {
  let stop = false;
  const onSig = (sig: string) => { ccLog("START", { signal: sig }, "stopping after the current step"); stop = true; };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  const alerts = Alerts.fromConfig(db, cfg);
  const trading = opts.paper || !!opts.executor;
  const rt: RuntimeState = { startedAt: Date.now(), observer: "starting", observerLastOkAt: null, strategy: trading ? "running" : "disabled",
    executor: opts.executor ? "live" : opts.paper ? "paper" : "disabled", lastError: null, reconnects: 0, timeouts: 0 };

  const prevBeat = getMeta(db, "heartbeat");
  const cleanStop = getMeta(db, "clean_stop") === "1";
  setMeta(db, "clean_stop", "0");
  healthEvent(db, "start", { mode: cfg.mode, pid: process.pid, previous_heartbeat: prevBeat, previous_clean_stop: cleanStop });
  if (prevBeat) {
    void alerts.raise({ event: "process_restart", severity: cleanStop ? "info" : "warning",
      message: cleanStop ? "service restarted after a clean stop" : `service restarted after an unclean stop (last heartbeat ${prevBeat})` });
  }

  const observer = new RefereeObserver(db, cfg.technocoreBaseUrl, cfg.rawLogDir, fetch, cfg.refereeStaleAgeS);
  const hl = new HyperliquidObserver(db, cfg.hyperliquidInfoUrl, cfg.hyperliquidCoin);
  const folds: OfficialFold[] = [];
  let paper: PaperTrader | null = null;
  let server: Server | null = null;

  ccLog("START", { mode: opts.executor ? "live" : opts.paper ? "paper" : "observe", referee_poll_ms: cfg.refereePollMs, hl_poll_ms: cfg.hlPollMs, decision_lead_ms: cfg.decisionLeadMs,
    estimator: cfg.estimator, stale_policy: cfg.stalePolicy, confirmation_policy: cfg.confirmationPolicy, strategy: opts.paper ? cfg.strategy : undefined,
    writes: opts.executor ? "LIVE: signed trades are posted by the LiveExecutor" : "NONE (paper/observe: no writer exists in this process)" });

  const guard = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { code?: string };
      rt.lastError = `${stage}: ${err.message}`;
      ccLog("ERROR", { stage, error: err.stack ?? String(e) });
      if (err.code?.startsWith("SQLITE_") && !/BUSY/.test(err.code)) {
        halt(db, "db_corruption", `${stage}: ${err.code} ${err.message}`, alerts);
        void alerts.raise({ event: "db_error", severity: "critical", message: `${stage}: ${err.code}` });
      }
      return undefined;
    }
  };

  try {
    await guard("observe", () => observer.pollOnce());
    await guard("hyperliquid", () => hl.pollOnce());
    await guard("reconcile", () => reconcileReferee(db));
    rt.observer = "running";

    if (trading) {
      const main = await OfficialFold.start(cfg.python, cfg.vendorRoot, foldConfig(contest));
      const look = await OfficialFold.start(cfg.python, cfg.vendorRoot, foldConfig(contest));
      folds.push(main, look);
      ccLog("FOLD", { vendor: cfg.vendorRoot, manifest_sha256: main.vendor.manifestSha256, fold_sha256: main.vendor.foldSha256, bytes: main.vendor.foldBytes },
        "official fold verified against the referee's pinned package and started");
      paper = new PaperTrader(db, cfg, contest, main, look, hl, opts.executor ?? PAPER_EXECUTOR);
      paper.alerts = alerts;
      await paper.start();
    }

    if (cfg.health.enabled) {
      server = await guard("health-server", () => startHealthServer(cfg.health.host, cfg.health.port,
        () => health(db, cfg, contest, rt), () => snapshot(db))) ?? null;
      if (server) ccLog("HEALTH", { url: `http://${cfg.health.host}:${cfg.health.port}/health` }, "local read-only health server listening");
    }

    const started = Date.now();
    let nextRef = 0;
    let nextHl = 0;
    let nextSafety = 0;
    let nextMaint = 0;
    let lastStateSweep = -1;
    const decided = new Set<number>();

    while (!stop) {
      const t = Date.now();
      if (opts.maxMinutes && t - started > opts.maxMinutes * 60_000) {
        ccLog("START", { minutes: opts.maxMinutes }, "time limit reached, stopping");
        break;
      }
      const current = lastClosedSweep(contest, t);
      const nextN = current + 1;
      const boundary = sweepTime(contest, nextN);

      if (paper && nextN <= contest.lockSweep && !decided.has(nextN) && t >= boundary - cfg.decisionLeadMs && t < boundary - 2_000) {
        decided.add(nextN);
        if (isHalted(db)) ccLog("SAFE MODE", { sweep: nextN }, "execution halted: estimate only, no intents");
        await guard("decide", () => paper!.decide(nextN, true, t));
      }

      if (t >= nextHl) {
        nextHl = t + cfg.hlPollMs;
        const trade = await guard("hyperliquid", () => hl.pollOnce(t));
        if (trade && Math.random() < cfg.hlPollMs / 60_000) ccLog("HL", { px: trade.px, tid: trade.tid, time: new Date(trade.timeMs).toISOString(), age_ms: t - trade.timeMs });
      }

      if (t >= nextRef) {
        const sinceBoundary = t - sweepTime(contest, Math.max(1, current));
        nextRef = t + (sinceBoundary >= 0 && sinceBoundary < 90_000 ? 2_000 : cfg.refereePollMs);
        const before = observer.errors;
        const events = (await guard("observe", () => observer.pollOnce())) ?? [];
        rt.observer = observer.errors > before ? "error" : "running";
        rt.reconnects += observer.errors > before ? 1 : 0;
        rt.timeouts = observer.timeouts;
        for (const ev of events) {
          if (ev.kind === "price" && paper) await guard("settle", () => paper!.settle(ev.n!, ev.post as PricePost));
          if (ev.kind === "price") {
            const p = ev.post as PricePost;
            const hlNow = hl.latest;
            ccLog("PRICE", { n: p.n, referee_close: p.ref.px, referee_tid: p.ref.tid, age_s: p.age_s, hl_latest: hlNow?.px, hl_tid: hlNow?.tid,
              hl_trade_age_ms: hl.ageMs(), hl_feed_age_ms: hl.feedAgeMs(), hl_minus_referee_bps: hlNow ? (((Number(hlNow.px) - Number(p.ref.px)) / Number(p.ref.px)) * 1e4).toFixed(2) : null });
            if ((p.age_s ?? 0) >= cfg.refereeStaleAgeS) {
              void alerts.raise({ event: "referee_stale", severity: "warning", message: `referee close is ${p.age_s}s old at sweep ${p.n}`, key: "referee_stale" });
            }
          }
        }
        if (events.length) await guard("reconcile", () => reconcileReferee(db));
        if (paper && opts.executor) {
          if (events.length) await guard("live-confirm", () => opts.executor!.confirmPosted?.());
          if (paper.deferred.size) await guard("live-settle", () => paper!.retryDeferred());
          if (events.length) await guard("live-verify", () => paper!.verifyWithReferee());
        }
        const snap = snapshot(db);
        if (snap.sweep !== null && snap.sweep !== lastStateSweep && snap.owners !== null) {
          lastStateSweep = snap.sweep;
          ccLog("STATE", { sweep: snap.sweep, close: snap.close, prev_ref: snap.previous_ref, age_s: snap.age_s, global: snap.global, owners: snap.owners,
            rooms: snap.rooms, open: snap.open_interest, longs: snap.longs, shorts: snap.shorts, hl: snap.hl_latest?.px, gaps: snap.gaps,
            missed: snap.missed_ranges.length, keys: snap.keys, paper: snap.paper_intents, halted: snap.halted });
          ccLog("LEADERBOARD", { sweep: snap.sweep, mark: snap.mark, top3: snap.top3.map(([d, s]) => `${d.slice(-8)}:${s}`) });
        }
      }

      if (opts.maintenance && t >= nextMaint) {
        nextMaint = t + 60_000;
        await guard("room-keeper", () => opts.maintenance!());
      }

      if (t >= nextSafety) {
        nextSafety = t + 30_000;
        await guard("safety", () => safetyChecks(db, cfg, rt, alerts, observer, hl, t));
        setMeta(db, "heartbeat", new Date(t).toISOString());
      }
      await sleep(1_000);
    }
  } finally {
    server?.close();
    for (const f of folds) f.stop();
    setMeta(db, "clean_stop", "1");
    healthEvent(db, "stop", { pid: process.pid });
  }
}

/** Transient halts that set and clear themselves; alerts on each change. */
export function safetyChecks(db: CcDb, cfg: CloseCallConfig, rt: RuntimeState, alerts: Alerts, observer: { lastOkAt: number | null },
  hl: { feedAgeMs: (n?: number) => number | null }, t = Date.now()): void {
  const lastRead = db.prepare("SELECT MAX(fetched_at) m FROM raw_posts WHERE room LIKE 'd-close1-%'").get() as { m: string | null };
  const silence = lastRead.m ? (t - Date.parse(lastRead.m)) / 1000 : null;
  if (silence !== null && silence >= cfg.haltRefereeSilenceS) {
    halt(db, "referee_stale", `no new referee message for ${Math.round(silence)} s`, alerts);
  } else if (silence !== null) {
    clearTransient(db, "referee_stale", alerts);
  }
  // FEED health (last successful poll), never the last trade's age: a quiet market is not a broken feed.
  const hlAge = hl.feedAgeMs(t);
  if (hlAge !== null && hlAge >= cfg.haltHlStaleMs) {
    halt(db, "hyperliquid_stale", `Hyperliquid feed: no successful poll for ${Math.round(hlAge / 1000)} s`, alerts);
    void alerts.raise({ event: "hyperliquid_stale", severity: "warning", message: `Hyperliquid feed down ${Math.round(hlAge / 1000)} s`, key: "hl" });
  } else if (hlAge !== null) {
    clearTransient(db, "hyperliquid_stale", alerts);
  }
  let freeMb = Number.POSITIVE_INFINITY;
  try {
    const s = statfsSync(cfg.dataDir);
    freeMb = (s.bavail * s.bsize) / 1_048_576;
  } catch { /* unknown */ }
  if (freeMb < cfg.diskLowMb) {
    halt(db, "disk_low", `${Math.round(freeMb)} MB free in ${cfg.dataDir}`, alerts);
    void alerts.raise({ event: "disk_low", severity: "critical", message: `${Math.round(freeMb)} MB free`, key: "disk" });
  } else {
    clearTransient(db, "disk_low", alerts);
  }
  rt.observerLastOkAt = observer.lastOkAt;
}
