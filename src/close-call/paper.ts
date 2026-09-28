/**
 * Paper trader: runs the exact future pipeline on real referee + Hyperliquid data
 * with FAKE keys, and never signs or posts.
 *
 *   T(n) - lead : estimate close -> strategy intent -> price & size -> risk checks
 *                 -> canonical terms -> maker/taker signatures WOULD be required
 *                 -> trade message WOULD be posted once -> official fold check
 *   referee posts sweep n : run the intents through the official fold with the REAL
 *                 ref/close -> settle or void, real fees, prediction error
 *
 * Two independent books are kept, both in the official fold:
 *   main       priced/sized with estimated_close (what we would really get)
 *   lookahead  same intents priced/sized with the actual close (impossible in
 *              reality; measures what the close uncertainty costs)
 * A TypeScript mirror (ledger.ts) runs beside the main book; any difference between
 * it and the fold halts the strategy (RECONCILE MISMATCH).
 */

import type { CloseCallConfig } from "./config.js";
import { lastClosedSweep, sweepTime, type Contest } from "./contest.js";
import { fmt2, fmtShort, max, toMicro, toNumber, type Micro } from "./decimal.js";
import { errorBps, estimateClose, type Estimate } from "./estimator.js";
import type { FoldSweepResult, OfficialFold } from "./fold.js";
import type { HyperliquidObserver } from "./hyperliquid.js";
import { Ledger, type FoldParams, type WireTrade } from "./ledger.js";
import { ccLog } from "./logger.js";
import { ensurePaperKeys, getKey, isTradable, keyStatusCounts, listKeys, transitionKey, wouldSign, type KeyRecord, type StrategyRole } from "./keys.js";
import { canonicalTerms, limitsFor, makerSigningString, newTradeId, takerSigningString, termsFromTrade, tradeMessageText, type PricePost, type Terms } from "./protocol.js";
import { closeBand, favoredPrice, maxPairQty, validateTrade } from "./risk.js";
import { decideStale } from "./stale-policy.js";
import { loadStrategyState, now, recordReconcile, saveStrategyState, type CcDb } from "./store.js";
import { halt, haltSummary } from "./safety.js";
import { contraDecide, contraInitial, contraPending, contraResolved, contraSpecs, contraUsedKeys, type ChampionSpec, type ContraLeg, type ContraState } from "./strategy/contra.js";
import { strategyK, type KState, type StrategyIntent } from "./strategy/k-ladder.js";

/** `contra` is set for CONTRA legs (strategy/contra.ts); K intents keep their pair (buyer = keys[2i], seller = keys[2i+1]). */
interface PendingTrade { intentId: string; sweep: number; intent: StrategyIntent; wire: WireTrade; estimate: Micro; ref: string;
  buyerId: string; sellerId: string; contra?: { champion: "long" | "short"; leg: ContraLeg } }

/** One trade to price, size and check: a K pair or a CONTRA leg. */
interface WorkItem { intent: StrategyIntent; buyer: KeyRecord; seller: KeyRecord; qtyCap: Micro | null; reserve: number; contra?: { champion: "long" | "short"; leg: ContraLeg } }

/**
 * Execution is the ONLY difference between paper and live. The decision engine below (estimate,
 * Strategy K, pair, favoured side, px, qty, stale policy, risk and fold checks) is identical and
 * hands each accepted intent to an executor:
 *   PaperExecutor  simulates: nothing is signed or sent (the intent is simply kept)
 *   LiveExecutor   (live/executor.ts) re-validates, signs maker+taker, posts once, journals every step
 */
export interface ExecIntent {
  intentId: string; sweep: number; pairIndex: number; makerId: string; takerId: string; terms: Terms; ref: string;
  decidedAtMs: number; deadlineMs: number;
}
export interface ExecResult { posted: boolean; state: string; detail: string }
export interface TradeExecutor {
  readonly live: boolean;
  /** Execute one intent. `precheck` re-runs every risk check against the state RIGHT NOW (empty = OK). */
  post(i: ExecIntent, precheck: () => Promise<string[]>): Promise<ExecResult>;
  /** The fold settled or voided a posted trade at the referee's real ref/close. */
  onSettled?(intentId: string, outcome: string, reason: string | null): void;
  /** On start: finish or reconcile what a crash interrupted. Never posts after the deadline, never re-posts blindly. */
  recover?(repost: (intentId: string) => Promise<string[] | null>): Promise<void>;
  /** Does the executor already hold a journal row for this intent? */
  has?(intentId: string): boolean;
  /**
   * Live only: may this posted trade enter our book for sweep n? "include" only when the referee
   * demonstrably read it (located in our room, stamped before the boundary, sweep's flow published,
   * seq outside every reported missed range); "exclude:<why>" when it certainly did not; "defer" when
   * that cannot be decided yet (never guessed).
   */
  admissible?(intentId: string, sweep: number): Promise<string>;
}
export const PAPER_EXECUTOR: TradeExecutor = { live: false, post: async () => ({ posted: true, state: "SIMULATED", detail: "paper: nothing signed or sent" }) };

/** Keys the live strategy may use: real, tradable, never used by a bootstrap/probe trade (those hold a 0.10 position). */
export function liveStrategyKeys(db: CcDb): KeyRecord[] {
  const used = new Set((db.prepare("SELECT maker_id m, taker_id t FROM trades").all() as { m: string; t: string }[]).flatMap((r) => [r.m, r.t]));
  const keys = listKeys(db).filter((k) => k.fake === 0 && (k.role ?? "strategy") === "strategy" && isTradable(k.status) && !used.has(k.id));
  return keys.slice(0, keys.length - (keys.length % 2));
}

export function foldParams(contest: Contest): FoldParams {
  return { mint: contest.mint, minQty: contest.minQty, window: contest.limitWindow, feeRate: contest.feeRate, lock: contest.lockSweep };
}

export function foldConfig(contest: Contest): Record<string, unknown> {
  return { mint: fmtShort(contest.mint), min_qty: fmtShort(contest.minQty), limit_window: fmtShort(contest.limitWindow),
    fee_rate: fmtShort(contest.feeRate), fee_rule: "clawback", lock_sweep: contest.lockSweep, prize_places: 3 };
}

interface SweepRow { n: number; ref_px: string | null; ref_tid: string | null; applied: string | null; lim_lo: string | null; lim_hi: string | null; lim_for: number | null; age_s: number | null }

export class PaperTrader {
  readonly ledger: Ledger;
  readonly lookLedger: Ledger;
  /** Strategy K's keys (pairs by index). Keys reserved for CONTRA are never in here. */
  keys: KeyRecord[] = [];
  /** Keys reserved for CONTRA (CLOSECALL_CONTRA_KEYS), in their configured order. */
  contraKeys: KeyRecord[] = [];
  contraSpecs: ChampionSpec[] | null = null;
  contraState: ContraState | null = null;
  /** Non-null: CONTRA makes no decision (kill switch off, or a reserved key failed the virgin check). */
  contraOff: string | null = "CLOSECALL_CONTRA_ENABLED is false";
  /** Replay / shadow only: the estimate recorded at that sweep instead of the live Hyperliquid feed. */
  estimateHook: ((n: number) => Estimate | null) | null = null;
  minted = false;
  state: KState;
  private strategy;
  alerts: import("./alerts.js").Alerts | null = null;
  private pending = new Map<number, PendingTrade[]>();
  private ourIds = new Set<string>();

  /** Clock for the pre-POST checks (tests inject one). */
  clock: () => number = Date.now;
  /** Live: a non-null reason (writer disarmed / kill switch) means estimates only, no new decisions. */
  canTrade: () => string | null = () => null;
  private postedThisSweep = new Map<number, WireTrade[]>();
  /** Live: sweeps whose settlement waits for the flow post or our trades' stamps. */
  readonly deferred = new Map<number, PricePost>();

  /**
   * The referee posted S: settle our whole book at S with the OFFICIAL fold (its `final` op, on a copy) and
   * keep our standings (score, position, fees, places) -- the evidence a prize claim rests on. Idempotent.
   */
  async finalize(S: string): Promise<{ S: string; ours: { key: string; id: string; score: string; places: number[] }[] }> {
    const res = (await this.fold.final(S)) as { S: string; owners: number; fees: string; standings: { key: string; score: string; position: string; fees: string; places: number[]; sharing: number }[] };
    const byDid = new Map(this.allKeys().map((k) => [k.did, k.id]));
    const ours = res.standings.filter((s) => byDid.has(s.key)).map((s) => ({ key: s.key, id: byDid.get(s.key)!, score: s.score, places: s.places, position: s.position, fees: s.fees }));
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('final_standings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ S: res.S, computed_at: now(), book: this.exec.live ? "live" : "paper", ours }));
    ccLog("PAPER SUMMARY", { final_S: res.S, our_keys: ours.length, best: ours[0] ? `${ours[0].id}:${ours[0].score}` : null },
      "FINAL: our book settled at S by the official fold (standings stored)");
    return { S: res.S, ours };
  }

  /** Live: retry deferred settlements (called by the service loop). */
  async retryDeferred(): Promise<void> {
    for (const [n, price] of [...this.deferred].sort((a, b) => a[0] - b[0])) await this.settle(n, price);
  }

  constructor(private db: CcDb, private cfg: CloseCallConfig, private contest: Contest,
    readonly fold: OfficialFold, readonly lookFold: OfficialFold, private hl: HyperliquidObserver | null,
    readonly exec: TradeExecutor = PAPER_EXECUTOR) {
    this.ledger = new Ledger(foldParams(contest));
    this.lookLedger = new Ledger(foldParams(contest));
    this.strategy = strategyK(cfg.strategy);
    this.state = loadStrategyState<KState>(db, "K") ?? this.strategy.initial();
  }

  get halted(): string | null {
    return haltSummary(this.db);
  }

  private halt(reason: string): void {
    halt(this.db, "reconcile_mismatch", reason);
  }

  /** Seed both books, create CC001..CCnnn, then replay every stored paper sweep through the official fold. */
  async start(): Promise<void> {
    const seed = this.db.prepare("SELECT price FROM seed WHERE id = 1").get() as { price: string } | undefined;
    if (!seed) throw new Error("no referee seed observed yet: run the observer first");
    for (const f of [this.fold, this.lookFold]) {
      await f.reset(foldConfig(this.contest));
      await f.seed(seed.price);
    }
    const reserved = new Set(this.cfg.contra.keys);
    if (this.exec.live) {
      const all = liveStrategyKeys(this.db);
      this.keys = all.filter((k) => !reserved.has(k.id));
      this.keys = this.keys.slice(0, this.keys.length - (this.keys.length % 2));
      if (this.keys.length < 2) throw new Error("live: fewer than 2 READY real keys available to the strategy (bootstrap first)");
    } else {
      const all = ensurePaperKeys(this.db, this.cfg.strategy.keyCount, this.cfg.paperKeyPrefix);
      for (const k of all) {
        if (k.status === "GENERATED") transitionKey(this.db, k.id, "REGISTER_PENDING", { reason: "paper: owner message WOULD be posted" });
      }
      this.keys = all.map((k) => getKey(this.db, k.id)).filter((k) => !reserved.has(k.id));
    }
    if (reserved.size) {
      const byId = new Map(listKeys(this.db).map((k) => [k.id, k]));
      const missing = this.cfg.contra.keys.filter((id) => !byId.has(id));
      if (missing.length) throw new Error(`CLOSECALL_CONTRA_KEYS names keys that do not exist: ${missing.join(" ")}`);
      this.contraKeys = this.cfg.contra.keys.map((id) => byId.get(id)!);
      this.contraSpecs = contraSpecs(this.cfg.contra.keys, this.cfg.contra.counterparties);
      this.contraState = loadStrategyState<ContraState>(this.db, "CONTRA") ?? contraInitial(this.contraSpecs);
    }
    const rows = this.db.prepare("SELECT * FROM paper_sweeps ORDER BY n").all() as
      { n: number; ref: string; close: string; owners: string; trades: string; lookahead_trades: string | null }[];
    for (const r of rows) {
      const owners = JSON.parse(r.owners) as string[];
      const trades = JSON.parse(r.trades) as WireTrade[];
      await this.fold.sweep(r.n, r.ref, r.close, owners, trades);
      this.ledger.sweep(r.n, toMicro(r.ref), toMicro(r.close), owners, trades);
      const look = r.lookahead_trades ? (JSON.parse(r.lookahead_trades) as WireTrade[]) : [];
      await this.lookFold.sweep(r.n, r.ref, r.close, owners, look);
      this.lookLedger.sweep(r.n, toMicro(r.ref), toMicro(r.close), owners, look);
      if (owners.length) this.minted = true;
      for (const t of trades) this.ourIds.add(t.id);
    }
    const open = this.db.prepare("SELECT * FROM intents WHERE outcome IS NULL AND risk_status = 'OK'").all() as Record<string, string>[];
    for (const i of open) this.pending.set(Number(i.sweep), [...(this.pending.get(Number(i.sweep)) ?? []), this.rowToPending(i)]);
    await this.reconcileBooks(null, "replay");
    if (this.contraState) this.contraSync();
    if (this.exec.recover) {
      await this.exec.recover(async (intentId) => {
        const p = [...this.pending.values()].flat().find((x) => x.intentId === intentId);
        return p ? this.precheck(p) : null;
      });
      // Crash between persisting an intent and the executor's first row: execute it now if still in time.
      if (this.exec.has) {
        for (const p of [...this.pending.values()].flat()) {
          if (this.exec.has(p.intentId)) continue;
          await this.exec.post(this.execIntent(p, this.clock()), () => this.precheck(p));
        }
      }
      this.dropUnsent();
    }
    ccLog("KEYS", { count: this.keys.length, fake: !this.exec.live, first: this.keys[0]?.id, last: this.keys.at(-1)?.id, statuses: keyStatusCounts(this.db),
      replayed_sweeps: rows.length, minted: this.minted, contra_keys: this.contraKeys.length, contra: this.contraKeys.length ? (this.contraOff ?? "ENABLED") : "none" });
  }

  /** K keys + CONTRA keys: everything in our book. */
  allKeys(): KeyRecord[] {
    return [...this.keys, ...this.contraKeys];
  }

  /**
   * CONTRA at start: rebuild its pending legs from the stored intents (the authority after a crash), then decide
   * whether it may trade. Every reserved key CONTRA has not used yet must be virgin: tradable and READY, never in
   * an intent / live trade / bootstrap trade, flat in our book. Otherwise CONTRA stays off (Strategy K is untouched).
   */
  private contraSync(): void {
    const specs = this.contraSpecs!;
    let st = this.contraState!;
    const open = this.db.prepare("SELECT intent_id, trigger FROM intents WHERE outcome IS NULL AND risk_status = 'OK' AND trigger LIKE 'contra-%'").all() as { intent_id: string; trigger: string }[];
    for (const c of st.champions) c.pending = [];
    for (const o of open) st = contraPending(st, o.trigger.split(":")[1] as "long" | "short", o.intent_id);
    this.contraState = st;
    saveStrategyState(this.db, "CONTRA", st);
    const used = contraUsedKeys(st, specs);
    const problems: string[] = [];
    for (const k of this.contraKeys) {
      const cur = getKey(this.db, k.id);
      if ((k.role ?? "strategy") !== "strategy" || (this.exec.live && k.fake !== 0)) problems.push(`${k.id}: not a ${this.exec.live ? "real " : ""}strategy key`);
      if (!isTradable(cur.status)) problems.push(`${k.id}: ${cur.status}`);
      if (used.has(k.id)) continue;
      if (cur.status !== "READY") problems.push(`${k.id}: ${cur.status}, not READY (it has traded)`);
      const traded = this.db.prepare(`SELECT (SELECT COUNT(*) FROM intents WHERE maker_id = ? OR taker_id = ?) + (SELECT COUNT(*) FROM live_trades WHERE maker_id = ? OR taker_id = ?)
        + (SELECT COUNT(*) FROM trades WHERE maker_id = ? OR taker_id = ?) n`).get(k.id, k.id, k.id, k.id, k.id, k.id) as { n: number };
      if (traded.n > 0) problems.push(`${k.id}: already in ${traded.n} trade(s)`);
      const acct = this.ledger.accounts.get(k.did);
      if (acct && (acct.position !== 0n || acct.lots.length)) problems.push(`${k.id}: not flat in our book`);
    }
    if (!this.cfg.contra.enabled) this.contraOff = "CLOSECALL_CONTRA_ENABLED is false";
    else if (problems.length) this.contraOff = `reserved keys not virgin: ${problems.slice(0, 5).join("; ")}`;
    else this.contraOff = null;
    ccLog(problems.length && this.cfg.contra.enabled ? "ERROR" : "STRATEGY", { strategy: "CONTRA", keys: this.contraKeys.length, used: used.size, problems: problems.length ? problems.slice(0, 5) : undefined,
      champions: st.champions.map((c) => `${c.name}:${c.champion} next=${c.next} flips=${c.flips} pending=${c.pending.length}`) },
      this.contraOff ? `CONTRA OFF: ${this.contraOff}` : "CONTRA ENABLED on its reserved keys (Strategy K never uses them)");
  }

  private rowToPending(i: Record<string, string>): PendingTrade {
    return {
      intentId: i.intent_id,
      sweep: Number(i.sweep),
      intent: { pairIndex: Number(i.pair_index), favored: i.favored as "long" | "short", trigger: i.trigger as StrategyIntent["trigger"], triggerPx: 0, level: { lo: null, hi: null }, tries: 0 },
      wire: { id: i.trade_id, maker: i.maker_did, side: "buy", qty: i.qty, px: i.px, taker: i.taker_did, until: Number(i.until), countersigner: i.taker_did },
      estimate: toMicro(i.estimated_close),
      ref: i.ref,
      buyerId: i.maker_id, sellerId: i.taker_id,
      ...(i.trigger?.startsWith("contra-") ? { contra: { champion: i.trigger.split(":")[1] as "long" | "short", leg: i.trigger.slice(7).split(":")[0] as ContraLeg } } : {}),
    };
  }

  private sweepRow(n: number): SweepRow | undefined {
    return this.db.prepare("SELECT n, ref_px, ref_tid, applied, lim_lo, lim_hi, lim_for, age_s FROM sweeps WHERE n = ?").get(n) as SweepRow | undefined;
  }

  private ledgerForChecks(): Ledger {
    return this.ledger.clone();
  }

  private status(did: string): string | undefined {
    const k = this.allKeys().find((x) => x.did === did);
    return k ? getKey(this.db, k.id).status : undefined;
  }

  /**
   * The reference sweep n's limits will use = the close of sweep n-1. The referee may post
   * late (29 minutes behind on 25 Sep), so when its post is missing we derive it ourselves:
   *   referee          the posted close of n-1
   *   stale-carry      the referee's latest post was stale (age_s >= threshold): it keeps reusing that trade
   *   hl-before-boundary  the referee's rule: Hyperliquid's last trade before boundary(n-1)
   */
  referenceFor(n: number): { ref: string; source: "referee" | "stale-carry" | "hl-before-boundary"; ageS: number | null; limits: [Micro, Micro] | null } | null {
    const prev = this.sweepRow(n - 1);
    if (prev?.ref_px) {
      const limits: [Micro, Micro] | null = prev.lim_for === n && prev.lim_lo && prev.lim_hi ? [toMicro(prev.lim_lo), toMicro(prev.lim_hi)] : null;
      return { ref: prev.ref_px, source: "referee", ageS: prev.age_s, limits };
    }
    const latest = this.db.prepare("SELECT n, ref_px, age_s FROM sweeps WHERE ref_px IS NOT NULL AND n < ? ORDER BY n DESC LIMIT 1").get(n) as
      { n: number; ref_px: string; age_s: number | null } | undefined;
    if (latest && (latest.age_s ?? 0) >= this.cfg.refereeStaleAgeS) {
      return { ref: latest.ref_px, source: "stale-carry", ageS: (latest.age_s ?? 0) + (n - 1 - latest.n) * 300, limits: null };
    }
    const hlBefore = this.hl?.lastBefore(sweepTime(this.contest, n - 1)) ?? null;
    if (hlBefore) return { ref: fmt2(toMicro(hlBefore.px)), source: "hl-before-boundary", ageS: null, limits: null };
    return latest ? { ref: latest.ref_px, source: "stale-carry", ageS: latest.age_s, limits: null } : null;
  }

  estimateFor(n: number, nowMs = Date.now()) {
    const r = this.referenceFor(n);
    if (this.estimateHook) return { est: this.estimateHook(n), r };
    const est = estimateClose(this.cfg.estimator, {
      lastRefPx: r?.ref ?? null, lastRefAgeS: r?.ageS ?? null,
      // Freshness = FEED health: the last trade, however old, is exactly what the close will be if nothing trades.
      hl: this.hl?.latest ?? null, hlAgeMs: this.hl?.feedAgeMs(nowMs) ?? null,
    }, this.cfg.hlStaleMs, this.cfg.refereeStaleAgeS);
    return { est, r };
  }

  /** Decide sweep n (called shortly before its boundary). `commit=false` is the dry-run: nothing is stored. */
  async decide(n: number, commit = true, nowMs = Date.now()): Promise<PendingTrade[]> {
    const { est, r } = this.estimateFor(n, nowMs);
    if (!r) {
      ccLog("ERROR", { stage: "decide", sweep: n }, "no reference available (no referee post, no Hyperliquid data): skipping");
      return [];
    }
    if (!est) {
      ccLog("ERROR", { stage: "decide", sweep: n }, "no estimate available, skipping");
      return [];
    }
    const prev = { ref_px: r.ref, age_s: r.ageS };
    const hl = this.hl?.latest ?? null;
    const hlAge = this.hl?.ageMs(nowMs) ?? null;
    const ref = toMicro(prev.ref_px);
    const limits: [Micro, Micro] | null = r.limits;
    ccLog("ESTIMATE", { sweep: n, boundary: new Date(sweepTime(this.contest, n)).toISOString(), source: this.cfg.estimator, used: est.used,
      estimated_close: fmtShort(est.value), ref: prev.ref_px, ref_source: r.source, referee_age_s: prev.age_s, hl_px: hl?.px, hl_tid: hl?.tid, hl_age_ms: hlAge,
      stale: est.stale, reason: est.reason });
    if (commit) {
      this.db.prepare(`INSERT INTO estimates (n, source, used, estimated_close, ref_prev, hl_px, hl_tid, hl_age_ms, referee_age_s, stale, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(n) DO UPDATE SET source=excluded.source, used=excluded.used,
        estimated_close=excluded.estimated_close, ref_prev=excluded.ref_prev, hl_px=excluded.hl_px, hl_tid=excluded.hl_tid,
        hl_age_ms=excluded.hl_age_ms, referee_age_s=excluded.referee_age_s, stale=excluded.stale, decided_at=excluded.decided_at`)
        .run(n, this.cfg.estimator, est.used, fmtShort(est.value), prev.ref_px, hl?.px ?? null, hl?.tid ?? null, hlAge, prev.age_s, est.stale ? 1 : 0, now());
    }
    if (this.halted) {
      ccLog("HALT", { sweep: n, reason: this.halted }, "strategy halted: estimate recorded, no intents");
      return [];
    }
    const noTrade = this.canTrade();
    if (noTrade) {
      ccLog("SAFE MODE", { sweep: n, reason: noTrade }, "writer disarmed: estimate recorded, no new decisions");
      return [];
    }
    if (!this.minted) {
      ccLog("KEYS", { sweep: n, statuses: keyStatusCounts(this.db) }, "no key is MINT_CONFIRMED yet: no intents (a registration is not a mint)");
      return [];
    }
    const lastPublished = (this.db.prepare("SELECT MAX(n) m FROM sweeps WHERE ref_px IS NOT NULL").get() as { m: number | null }).m ?? 0;
    const delayMin = Math.max(0, (nowMs - sweepTime(this.contest, lastPublished + 1)) / 60_000);
    const divergenceBps = hl ? Math.abs(Number(hl.px) - Number(prev.ref_px)) / Number(prev.ref_px) * 10_000 : null;
    const stale = decideStale(this.cfg.stalePolicy, { ageS: prev.age_s, delayMin, divergenceBps, refEstimated: r.source !== "referee" });
    ccLog("STRATEGY", { sweep: n, stale_policy: stale.decision, reason: stale.reason, referee_delay_min: delayMin.toFixed(1),
      age_s: prev.age_s, hl_ref_divergence_bps: divergenceBps?.toFixed(1) ?? null });
    if (stale.decision === "HALT_NEW_ENTRIES") {
      if (commit) this.db.prepare(`INSERT INTO strategy_triggers (sweep, strategy, trigger, estimate, policy, decision, detail, at)
        VALUES (?, 'K', 'stale-check', ?, ?, 'no new entries', ?, ?)`).run(n, fmtShort(est.value), this.cfg.stalePolicy.mode, stale.reason, now());
      return [];
    }
    const wide = stale.decision === "REDUCE";
    const priceMargin = wide ? this.cfg.stalePriceMargin : this.cfg.strategy.priceMargin;
    const qtyMargin = wide ? this.cfg.staleQtyMargin : this.cfg.strategy.qtyMargin;
    const pairCount = Math.floor(this.keys.length / 2);
    const decision = this.strategy.decide(this.state, { sweep: n, estimate: toNumber(est.value), lockSweep: this.contest.lockSweep, pairCount });
    for (const note of decision.notes) ccLog("STRATEGY", { sweep: n, strategy: "K", threshold: this.cfg.strategy.threshold }, note);
    if (commit) {
      for (const it of decision.intents) {
        this.db.prepare(`INSERT INTO strategy_triggers (sweep, strategy, trigger, pair_index, estimate, policy, decision, detail, at)
          VALUES (?, 'K', ?, ?, ?, ?, ?, ?, ?)`).run(n, it.trigger, it.pairIndex, fmtShort(est.value), stale.decision, `open pair favouring ${it.favored}`,
          JSON.stringify({ lo: it.level.lo, hi: it.level.hi, tries: it.tries }), now());
      }
    }
    ccLog("STRATEGY", { sweep: n, intents: decision.intents.length, triggers_total: decision.state.triggers, next_pair: decision.state.nextPair,
      pairs_left: pairCount - decision.state.nextPair, lo: decision.state.lo, hi: decision.state.hi, estimate: fmtShort(est.value) });

    let st = decision.state;
    // K pairs first (unchanged: buyer = keys[2i], seller = keys[2i+1]); CONTRA legs after them, on their own keys.
    const work: WorkItem[] = decision.intents.map((intent) => ({ intent, buyer: this.keys[2 * intent.pairIndex], seller: this.keys[2 * intent.pairIndex + 1], qtyCap: null, reserve: this.cfg.strategy.reserve }));
    if (this.contraState && !this.contraOff) {
      const positions = Object.fromEntries(this.contraKeys.map((k) => [k.id, this.ledger.accounts.get(k.did)?.position ?? 0n]));
      const cd = contraDecide(this.contraState, this.contraSpecs!, this.cfg.contra.threshold, { sweep: n, estimate: toNumber(est.value), lockSweep: this.contest.lockSweep, positions });
      for (const note of cd.notes) ccLog("STRATEGY", { sweep: n, strategy: "CONTRA", threshold: this.cfg.contra.threshold }, note);
      if (commit) {
        // Counterparties are consumed HERE, persisted before any intent row or POST: never reused, even after a crash.
        this.contraState = cd.state;
        saveStrategyState(this.db, "CONTRA", cd.state);
        for (const ci of cd.intents) {
          this.db.prepare(`INSERT INTO strategy_triggers (sweep, strategy, trigger, pair_index, estimate, policy, decision, detail, at)
            VALUES (?, 'CONTRA', ?, -1, ?, ?, ?, ?, ?)`).run(n, `contra-${ci.leg}:${ci.champion}`, fmtShort(est.value), stale.decision,
            `${ci.leg} ${ci.champion} champion ${ci.dir > 0 ? "buys" : "sells"}`, JSON.stringify({ champion: ci.championId, counterparty: ci.counterpartyId, qty_cap: ci.qtyCap }), now());
        }
      }
      const byId = new Map(this.contraKeys.map((k) => [k.id, k]));
      for (const ci of cd.intents) {
        const champ = byId.get(ci.championId)!, cp = byId.get(ci.counterpartyId)!;
        work.push({ intent: { pairIndex: -1, favored: ci.favored, trigger: `contra-${ci.leg}:${ci.champion}` as StrategyIntent["trigger"], triggerPx: ci.estimate, level: { lo: null, hi: null }, tries: 0 },
          buyer: ci.dir > 0 ? champ : cp, seller: ci.dir > 0 ? cp : champ, qtyCap: ci.qtyCap === null ? null : BigInt(ci.qtyCap), reserve: ci.leg === "close" ? 0 : this.cfg.contra.reserve, contra: { champion: ci.champion, leg: ci.leg } });
      }
      ccLog("STRATEGY", { sweep: n, strategy: "CONTRA", intents: cd.intents.length, champions: cd.state.champions.map((c) => `${c.name}:next=${c.next} flips=${c.flips} anchor=${c.anchor}`) });
    }
    const release = (w: WorkItem) => { if (!w.contra) st = this.strategy.onResult(st, w.intent.pairIndex, w.intent.favored, w.intent.trigger, w.intent.tries, false); };
    const accepted: PendingTrade[] = [];
    const lchk = this.ledgerForChecks();
    const lim = limits ?? null;
    for (const w of work) {
      const { intent, buyer, seller } = w;
      if (!isTradable(this.status(buyer.did)) || !isTradable(this.status(seller.did))) {
        ccLog("RISK", { sweep: n, pair: intent.pairIndex, trigger: intent.trigger, buyer: `${buyer.id}:${this.status(buyer.did)}`, seller: `${seller.id}:${this.status(seller.did)}` },
          "pair not tradable (keys must be READY or ACTIVE): intent dropped");
        release(w);
        continue;
      }
      if (!lchk.accounts.has(buyer.did) || !lchk.accounts.has(seller.did)) {
        ccLog("RISK", { sweep: n, pair: intent.pairIndex, trigger: intent.trigger, buyer: buyer.id, seller: seller.id }, "pair not minted in our book yet: intent dropped");
        release(w);
        continue;
      }
      const px = favoredPrice(intent.favored, est.value, priceMargin, lim ?? limitsFromRef(ref, this.contest));
      const band = closeBand(est.value, qtyMargin);
      const l2 = lchk.clone();
      if (accepted.length) {
        l2.sweepN = Math.min(l2.sweepN, n - 1);
        l2.sweep(n, ref, est.value, [], accepted.map((a) => a.wire));
      }
      let qty = maxPairQty(l2, l2.accounts.get(buyer.did)!, l2.accounts.get(seller.did)!, px, band, w.reserve);
      if (w.qtyCap !== null && w.qtyCap < qty) qty = w.qtyCap;          // a CONTRA close never sells/buys more than the position
      const until = this.cfg.strategy.untilPolicy === "this-sweep" ? n : n + 1;
      const wire: WireTrade = { id: newTradeId(), maker: buyer.did, side: "buy", qty: fmt2(qty), px: fmt2(px), taker: seller.did, until, countersigner: seller.did };
      const risk = validateTrade(wire, {
        ledger: lchk, sweep: n, lockSweep: this.contest.lockSweep, ref, postedLimits: lim, estimate: est.value, qtyMargin,
        reserve: this.cfg.strategy.reserve, knownSettledIds: (id) => !!this.db.prepare("SELECT 1 FROM settled_ids WHERE id = ?").get(id),
        ourIds: this.ourIds, earlierTrades: accepted.map((a) => a.wire), keyStatus: (did) => this.status(did),
      });
      // Official fold, on a copy, at the estimate and at both band edges: must settle everywhere.
      let foldOk = risk.ok;
      const foldNotes: string[] = [];
      if (risk.ok) {
        for (const c of band) {
          const res = await this.fold.check(n, prev.ref_px, fmt2(c), [], [...accepted.map((a) => a.wire), wire]);
          const out = res.trades.at(-1)!;
          const mirror = (() => { const l3 = lchk.clone(); l3.sweepN = Math.min(l3.sweepN, n - 1); return l3.sweep(n, ref, c, [], [...accepted.map((a) => a.wire), wire]).outcomes.at(-1)!; })();
          if (out.outcome !== "settled") { foldOk = false; foldNotes.push(`fold voids at close ${fmt2(c)}: ${out.reason}`); }
          if (out.outcome !== mirror.outcome || (out.reason ?? null) !== (mirror.reason ?? null)) {
            foldOk = false;
            recordReconcile(this.db, n, "L2-intent", "MISMATCH", { close: fmt2(c), fold: out, mirror });
            ccLog("RECONCILE MISMATCH", { level: "L2-intent", sweep: n, close: fmt2(c), fold: out.outcome + ":" + (out.reason ?? ""), mirror: mirror.outcome + ":" + (mirror.reason ?? "") });
            this.halt(`L2 intent mismatch at sweep ${n}`);
          }
        }
      }
      const terms = termsFromTrade({ id: wire.id, maker: wire.maker, side: "buy", qty, px, taker: wire.taker, until });
      const makerSig = wouldSign(buyer.did, makerSigningString(terms));
      const takerSig = wouldSign(seller.did, takerSigningString(terms, seller.did));
      const preview = tradeMessageText(terms, seller.did, "<maker_sig 86 chars>", "<taker_sig 86 chars>");
      const intentId = w.contra ? `${n}-contra-${w.contra.champion}-${w.contra.leg}-${wire.id.slice(0, 8)}` : `${n}-${intent.pairIndex}-${wire.id.slice(0, 8)}`;
      const status = risk.ok && foldOk ? "OK" : "REJECTED";
      const failed = [...risk.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ""}`), ...foldNotes];
      ccLog(this.exec.live ? "LIVE INTENT" : "PAPER INTENT", {
        sweep: n, pair: intent.pairIndex, trigger: intent.trigger, tries: intent.tries, favored: intent.favored,
        maker: buyer.id, maker_did: buyer.did, taker: seller.id, taker_did: seller.did, side: "buy", qty: wire.qty, px: wire.px, until,
        ref: prev.ref_px, ref_source: r.source, limits: lim ? [fmt2(lim[0]), fmt2(lim[1])] : "formula", estimated_close: fmtShort(est.value), estimator: est.used,
        price_margin: priceMargin, qty_margin: qtyMargin, threshold_trigger_px: intent.triggerPx,
        expected_maker_fee: risk.expected.makerFee, expected_taker_fee: risk.expected.takerFee,
        expected_maker_collateral: risk.expected.makerCollateral, expected_taker_collateral: risk.expected.takerCollateral,
        trade_id: wire.id, risk: status, failed: failed.length ? failed : undefined,
        ...(this.exec.live ? { execution: "live: re-checked, signed and posted once by the LiveExecutor" }
          : { maker_signature: "WOULD BE REQUIRED", taker_signature: "WOULD BE REQUIRED", post: "WOULD BE POSTED ONCE (complete trade)" }),
      });
      if (commit) {
        this.db.prepare(`INSERT INTO intents (intent_id, sweep, pair_index, trigger, favored, maker_id, taker_id, maker_did, taker_did, side, qty, px, until,
          ref, lim_lo, lim_hi, estimated_close, estimator, price_margin, qty_margin, trade_id, terms, maker_signing, taker_signing, message_preview,
          expected_maker_fee, expected_taker_fee, expected_maker_collateral, expected_taker_collateral, risk_status, risk_detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          intentId, n, intent.pairIndex, intent.trigger, intent.favored, buyer.id, seller.id, buyer.did, seller.did, wire.qty, wire.px, until,
          prev.ref_px, lim ? fmt2(lim[0]) : null, lim ? fmt2(lim[1]) : null, fmtShort(est.value), est.used, priceMargin, qtyMargin, wire.id,
          canonicalTerms(terms), JSON.stringify(makerSig), JSON.stringify(takerSig), preview,
          risk.expected.makerFee, risk.expected.takerFee, risk.expected.makerCollateral, risk.expected.takerCollateral, status,
          JSON.stringify({ ref_source: r.source, checks: risk.checks, fold: foldNotes }), now());
      }
      if (status === "OK") {
        const p: PendingTrade = { intentId, sweep: n, intent, wire, estimate: est.value, ref: prev.ref_px, buyerId: buyer.id, sellerId: seller.id, ...(w.contra ? { contra: w.contra } : {}) };
        accepted.push(p);
        this.ourIds.add(wire.id);
      } else {
        ccLog("RISK", { sweep: n, pair: intent.pairIndex, trigger: intent.trigger, trade_id: wire.id, failed }, "intent blocked: it would not be sent");
        release(w);
      }
    }
    if (!commit) return accepted;
    // Persist intents + strategy state BEFORE any POST: a crash from here on can never re-trigger the same
    // entry or mint a new trade id for it (recovery works from the stored intents and live_trades rows).
    this.state = st;
    saveStrategyState(this.db, "K", this.state);
    if (this.contraState) {
      for (const p of accepted) if (p.contra) this.contraState = contraPending(this.contraState, p.contra.champion, p.intentId);
      saveStrategyState(this.db, "CONTRA", this.contraState);
    }
    const sent: PendingTrade[] = [];
    // Serialized: one POST at a time, each re-validated against the book including the ones already posted.
    for (const [idx, p] of accepted.entries()) {
      const r = this.exec.live && idx >= this.cfg.maxTradesPerSweep
        ? { posted: false, state: "NOT_POSTED", detail: `over CLOSECALL_MAX_TRADES_PER_SWEEP=${this.cfg.maxTradesPerSweep}` }
        : await this.exec.post(this.execIntent(p, nowMs), () => this.precheck(p));
      if (r.posted) {
        sent.push(p);
        this.postedThisSweep.set(n, [...(this.postedThisSweep.get(n) ?? []), p.wire]);
      } else if (r.state === "UNKNOWN") {
        // It may exist: it stays pending (its settlement waits for the evidence) and its keys are never released
        // until it is resolved; it also counts against the funds of this sweep's later posts.
        sent.push(p);
        this.postedThisSweep.set(n, [...(this.postedThisSweep.get(n) ?? []), p.wire]);
        ccLog("HALT", { sweep: n, pair: p.intent.pairIndex, trade_id: p.wire.id }, "POST outcome UNKNOWN: pending until resolved by read-back after the boundary; pair blocked");
      } else {
        this.db.prepare("UPDATE intents SET risk_status = 'NOT_SENT', risk_detail = ? WHERE intent_id = ?").run(JSON.stringify({ state: r.state, detail: r.detail }), p.intentId);
        ccLog("RISK", { sweep: n, pair: p.intent.pairIndex, trigger: p.intent.trigger, trade_id: p.wire.id, state: r.state, detail: r.detail }, "intent not executed (nothing stored): pair released for a retry");
        this.resolveOne(p, false);
      }
    }
    saveStrategyState(this.db, "K", this.state);
    if (this.contraState) saveStrategyState(this.db, "CONTRA", this.contraState);
    if (sent.length) this.pending.set(n, sent);
    return sent;
  }

  /** The executor's view of an accepted intent: the decision, unchanged. */
  execIntent(p: PendingTrade, decidedAtMs: number): ExecIntent {
    const n = p.sweep;
    return {
      intentId: p.intentId, sweep: n, pairIndex: p.intent.pairIndex, makerId: p.buyerId, takerId: p.sellerId,
      ref: p.ref, decidedAtMs, deadlineMs: sweepTime(this.contest, n) - this.cfg.postGuardMs,
      terms: termsFromTrade({ id: p.wire.id, maker: p.wire.maker, side: "buy", qty: toMicro(p.wire.qty), px: toMicro(p.wire.px), taker: p.wire.taker, until: p.wire.until }),
    };
  }

  /** One intent is over (settled, voided, not applied, not sent): K releases/advances its pair; CONTRA frees its champion. */
  private resolveOne(p: PendingTrade, settled: boolean): void {
    if (p.contra) { if (this.contraState) this.contraState = contraResolved(this.contraState, p.intentId); return; }
    this.state = this.strategy.onResult(this.state, p.intent.pairIndex, p.intent.favored, p.intent.trigger, p.intent.tries, settled);
  }

  /** Intents the executor did not send (recovery): out of the pending book, pair released. */
  private dropUnsent(): void {
    const unsent = new Set((this.db.prepare("SELECT intent_id FROM intents WHERE risk_status = 'NOT_SENT' AND outcome IS NULL").all() as { intent_id: string }[]).map((r) => r.intent_id));
    for (const [n, list] of this.pending) {
      const keep = list.filter((p) => !unsent.has(p.intentId));
      for (const p of list.filter((x) => unsent.has(x.intentId))) this.resolveOne(p, false);
      if (keep.length) this.pending.set(n, keep); else this.pending.delete(n);
    }
    saveStrategyState(this.db, "K", this.state);
    if (this.contraState) saveStrategyState(this.db, "CONTRA", this.contraState);
  }

  /**
   * Every check again, against the state right now, immediately before a live POST (empty = OK):
   * not halted, still before the deadline, same reference, stale policy not halting, limits, balances,
   * collateral, fees, key states (validateTrade on the current book plus our trades already posted this sweep).
   */
  async precheck(p: PendingTrade): Promise<string[]> {
    const fails: string[] = [];
    const n = p.sweep;
    const t = this.clock();
    if (this.halted) fails.push(`halted: ${this.halted}`);
    const noTrade = this.canTrade();
    if (noTrade) fails.push(`writer disarmed: ${noTrade}`);
    if (lastClosedSweep(this.contest, t) >= n || t >= sweepTime(this.contest, n) - this.cfg.postGuardMs) fails.push(`sweep ${n}: past the posting deadline`);
    const { est, r } = this.estimateFor(n, t);
    if (!r || r.ref !== p.ref) fails.push(`reference changed: ${p.ref} -> ${r?.ref ?? "none"}`);
    if (!est) fails.push("no estimate");
    if (r && est) {
      const lastPublished = (this.db.prepare("SELECT MAX(n) m FROM sweeps WHERE ref_px IS NOT NULL").get() as { m: number | null }).m ?? 0;
      const hl = this.hl?.latest ?? null;
      const stale = decideStale(this.cfg.stalePolicy, { ageS: r.ageS, delayMin: Math.max(0, (t - sweepTime(this.contest, lastPublished + 1)) / 60_000),
        divergenceBps: hl ? Math.abs(Number(hl.px) - Number(r.ref)) / Number(r.ref) * 10_000 : null, refEstimated: r.source !== "referee" });
      if (stale.decision === "HALT_NEW_ENTRIES") fails.push(`stale policy: ${stale.reason}`);
      const others = new Set(this.ourIds);
      others.delete(p.wire.id);
      const risk = validateTrade(p.wire, {
        ledger: this.ledgerForChecks(), sweep: n, lockSweep: this.contest.lockSweep, ref: toMicro(r.ref), postedLimits: r.limits, estimate: est.value,
        qtyMargin: this.cfg.strategy.qtyMargin, reserve: this.cfg.strategy.reserve,
        knownSettledIds: (id) => !!this.db.prepare("SELECT 1 FROM settled_ids WHERE id = ?").get(id),
        ourIds: others, earlierTrades: this.postedThisSweep.get(n) ?? [], keyStatus: (did) => this.status(did),
      });
      for (const c of risk.checks.filter((x) => !x.ok && x.name !== "fee_close_band")) fails.push(`${c.name}: ${c.detail ?? ""}`);
    }
    return fails;
  }

  /** The referee posted sweep n: resolve the estimate and settle our paper intents with the real ref/close. */
  async settle(n: number, price: PricePost): Promise<void> {
    const close = price.ref.px;
    const refStr = price.applied ?? this.sweepRow(n - 1)?.ref_px;
    if (!refStr) {
      ccLog("ERROR", { stage: "settle", sweep: n }, "cannot settle: unknown reference");
      return;
    }
    this.resolveEstimate(n, price);
    if (!this.minted && !this.exec.live) {
      await this.paperMint(n, refStr, close);
      return;
    }
    let pend = this.pending.get(n) ?? [];
    if (this.exec.admissible && pend.length) {
      const verdicts = await Promise.all(pend.map((p) => this.exec.admissible!(p.intentId, n)));
      if (verdicts.includes("defer")) {
        this.deferred.set(n, price);
        ccLog("LIVE RESULT", { sweep: n, waiting: verdicts.filter((v) => v === "defer").length }, "settlement deferred: waiting for the flow post / the stamp of our trades");
        return;
      }
      this.deferred.delete(n);
      const excluded = pend.filter((_, i) => verdicts[i] !== "include");
      for (const p of excluded) {
        const why = verdicts[pend.indexOf(p)].replace(/^exclude:/, "");
        this.db.prepare("UPDATE intents SET outcome = 'void', reason = ?, actual_close = ?, result_at = ? WHERE intent_id = ?").run(`not_applied:${why}`, close, now(), p.intentId);
        this.exec.onSettled?.(p.intentId, "not_applied", why);
        this.resolveOne(p, false);
        ccLog("LIVE RESULT", { sweep: n, trade_id: p.wire.id, outcome: "NOT_APPLIED", why }, "the referee did not read this trade: kept out of our book, pair released");
      }
      pend = pend.filter((_, i) => verdicts[i] === "include");
    }
    this.pending.delete(n);
    this.postedThisSweep.delete(n);
    // Live: our real keys enter our book the first sweep after they are READY (their mint is confirmed by
    // PROTOCOL evidence before that, so the referee minted them no later than this sweep).
    const owners: string[] = this.exec.live ? this.allKeys().filter((k) => !this.ledger.accounts.has(k.did)).map((k) => k.did) : [];
    if (!pend.length && !owners.length) return;
    if (owners.length) ccLog("KEYS", { sweep: n, entering_book: owners.length }, "live keys minted in our book (official fold)");
    const trades = pend.map((p) => p.wire);
    const res = (await this.fold.sweep(n, refStr, close, owners, trades)) as FoldSweepResult;
    const mirror = this.ledger.sweep(n, toMicro(refStr), toMicro(close), owners, trades);

    // Look-ahead book: the same intents, priced and sized knowing the real close.
    const look = this.lookaheadTrades(n, pend, toMicro(refStr), toMicro(close), owners);
    const lookRes = (await this.lookFold.sweep(n, refStr, close, owners, look)) as FoldSweepResult;
    this.lookLedger.sweep(n, toMicro(refStr), toMicro(close), owners, look);
    this.db.prepare(`INSERT OR REPLACE INTO paper_sweeps (n, ref, close, owners, trades, fold_result, lookahead_trades, lookahead_result, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(n, refStr, close, JSON.stringify(owners), JSON.stringify(trades), JSON.stringify(res),
      JSON.stringify(look), JSON.stringify(lookRes), now());

    for (let i = 0; i < pend.length; i++) {
      const p = pend[i];
      const out = res.trades[i];
      const m = mirror.outcomes[i];
      const lk = lookRes.trades[i];
      const agree = out.outcome === m.outcome && (out.reason ?? null) === (m.reason ?? null) &&
        (out.outcome !== "settled" || (toMicro(out.maker_fee!) === m.makerFee && toMicro(out.taker_fee!) === m.takerFee));
      if (!agree) {
        recordReconcile(this.db, n, "L2-settle", "MISMATCH", { fold: out, mirror: m });
        ccLog("RECONCILE MISMATCH", { level: "L2-settle", sweep: n, trade_id: p.wire.id, fold: out, mirror: { ...m, makerFee: m.makerFee?.toString(), takerFee: m.takerFee?.toString() } });
        this.halt(`L2 settle mismatch at sweep ${n}`);
      }
      const errBps = errorBps(p.estimate, toMicro(close));
      const settled = out.outcome === "settled";
      if (!settled) void this.alerts?.raise({ event: "trade_void", severity: "warning", message: `paper trade ${p.wire.id} would be void: ${out.reason}`,
        key: p.wire.id, detail: { sweep: n, pair: p.intent.pairIndex, reason: out.reason } });
      this.db.prepare(`UPDATE intents SET outcome = ?, reason = ?, actual_close = ?, actual_maker_fee = ?, actual_taker_fee = ?, prediction_error_bps = ?,
        ts_predicted_outcome = ?, lookahead_px = ?, lookahead_qty = ?, lookahead_outcome = ?, result_at = ? WHERE intent_id = ?`).run(
        out.outcome, out.reason ?? null, close, out.maker_fee ?? null, out.taker_fee ?? null, errBps, m.outcome + (m.reason ? ":" + m.reason : ""),
        look[i]?.px ?? null, look[i]?.qty ?? null, lk ? lk.outcome + (lk.reason ? ":" + lk.reason : "") : null, now(), p.intentId);
      const row = this.db.prepare("SELECT expected_maker_fee, expected_taker_fee FROM intents WHERE intent_id = ?").get(p.intentId) as { expected_maker_fee: string; expected_taker_fee: string };
      ccLog("PAPER RESULT", {
        sweep: n, pair: p.intent.pairIndex, trade_id: p.wire.id, favored: p.intent.favored, qty: p.wire.qty, px: p.wire.px,
        ref_predicted: p.ref, ref_actual: refStr, ref_hit: toMicro(p.ref) === toMicro(refStr), estimated_close: fmtShort(p.estimate), actual_close: close, prediction_error_bps: errBps.toFixed(2),
        would: settled ? "SETTLE" : "VOID", reason: out.reason ?? null,
        expected_maker_fee: row.expected_maker_fee, actual_maker_fee: out.maker_fee ?? null,
        expected_taker_fee: row.expected_taker_fee, actual_taker_fee: out.taker_fee ?? null,
        mirror: agree ? "agrees" : "DISAGREES",
        lookahead: lk ? `${lk.outcome} px=${look[i].px} qty=${look[i].qty} maker_fee=${lk.maker_fee ?? "-"}` : "-",
      });
      if (settled && !p.contra) {
        const buyer = this.keys[2 * p.intent.pairIndex];
        const seller = this.keys[2 * p.intent.pairIndex + 1];
        const role = (k: "buy" | "sell") => (k === "buy" ? (p.intent.favored === "long" ? "long*" : "long") : (p.intent.favored === "short" ? "short*" : "short"));
        for (const [k, side] of [[buyer, "buy"], [seller, "sell"]] as const) {
          transitionKey(this.db, k.id, "ACTIVE", { patch: { strategy_role: role(side), pair_index: p.intent.pairIndex, entry_reference: close, entry_sweep: n, entry_px: p.wire.px } });
        }
      }
      if (settled && p.contra) {
        // The champion trades many times: READY -> ACTIVE once; its role and last entry are updated in place.
        for (const id of [p.buyerId, p.sellerId]) {
          const champion = this.contraSpecs!.some((c) => c.champion === id);
          const patch = { strategy_role: (champion ? `contra-champion-${p.contra.champion}` : `contra-cp-${p.contra.champion}`) as StrategyRole, pair_index: -1, entry_reference: close, entry_sweep: n, entry_px: p.wire.px };
          if (getKey(this.db, id).status === "READY") transitionKey(this.db, id, "ACTIVE", { patch });
          else this.db.prepare("UPDATE keys SET strategy_role = ?, entry_reference = ?, entry_sweep = ?, entry_px = ?, updated_at = ? WHERE id = ?").run(patch.strategy_role, close, n, p.wire.px, now(), id);
        }
      }
      this.resolveOne(p, settled);
      this.exec.onSettled?.(p.intentId, out.outcome, out.reason ?? null);
    }
    if (owners.length) this.minted = true;
    saveStrategyState(this.db, "K", this.state);
    if (this.contraState) saveStrategyState(this.db, "CONTRA", this.contraState);
    await this.reconcileBooks(n, "settle");
    await this.summary(n, close);
  }

  /**
   * Paper registration: mint every paper key in the official fold at the first referee sweep we see,
   * with no trades. A key becomes MINT_CONFIRMED only for the DIDs the fold's sweep result lists in
   * `minted` (evidence source paper-fold), then READY. Trading starts at the NEXT decision.
   */
  private async paperMint(n: number, ref: string, close: string): Promise<void> {
    const owners = this.allKeys().map((k) => k.did);
    const res = (await this.fold.sweep(n, ref, close, owners, [])) as FoldSweepResult;
    this.ledger.sweep(n, toMicro(ref), toMicro(close), owners, []);
    const look = (await this.lookFold.sweep(n, ref, close, owners, [])) as FoldSweepResult;
    this.lookLedger.sweep(n, toMicro(ref), toMicro(close), owners, []);
    this.db.prepare(`INSERT OR REPLACE INTO paper_sweeps (n, ref, close, owners, trades, fold_result, lookahead_trades, lookahead_result, at)
      VALUES (?, ?, ?, ?, '[]', ?, '[]', ?, ?)`).run(n, ref, close, JSON.stringify(owners), JSON.stringify(res), JSON.stringify(look), now());
    const minted = new Set(res.minted);
    for (const k of this.allKeys()) {
      if (!minted.has(k.did)) {
        ccLog("KEYS", { key: k.id, sweep: n }, "not in the fold's minted list: stays REGISTER_PENDING");
        continue;
      }
      transitionKey(this.db, k.id, "MINT_CONFIRMED", { evidence: { source: "paper-fold", sweep: n, detail: "official fold sweep result lists the DID in minted (paper)" } });
      transitionKey(this.db, k.id, "READY");
    }
    this.minted = minted.size > 0;
    this.keys = this.keys.map((k) => getKey(this.db, k.id));
    this.contraKeys = this.contraKeys.map((k) => getKey(this.db, k.id));
    if (this.contraState) this.contraSync();                          // paper: the reserved keys are READY only now
    ccLog("KEYS", { sweep: n, minted: minted.size, statuses: keyStatusCounts(this.db) }, "paper mint confirmed by the official fold; trading may start next sweep");
  }

  private lookaheadTrades(n: number, pend: PendingTrade[], ref: Micro, close: Micro, owners: string[]): WireTrade[] {
    const l = this.lookLedger.clone();
    void owners;
    const out: WireTrade[] = [];
    for (const p of pend) {
      const buyer = l.accounts.get(p.wire.maker)!;
      const seller = l.accounts.get(p.wire.countersigner)!;
      const px = favoredPrice(p.intent.favored, close, 0, limitsFromRef(ref, this.contest));
      const qty = maxPairQty(l, buyer, seller, px, [close], this.cfg.strategy.reserve);
      const t: WireTrade = { ...p.wire, id: p.wire.id.slice(0, 24) + "look" + p.wire.id.slice(28), px: fmt2(px), qty: fmt2(max(qty, 0n)) };
      out.push(t);
      l.sweepN = Math.min(l.sweepN, n - 1);
      l.sweep(n, ref, close, [], [t]);
    }
    return out;
  }

  /**
   * Live: our book is the official fold fed with OUR trades at the referee's own ref/close, so its outcome
   * is the referee's. Every one of our trade ids the referee does list is checked against it; any
   * disagreement is a grave halt (the observer keeps running). Lists are truncated at 4,096 chars, so
   * an unlisted id stays "unlisted" (verified only by the fold).
   */
  verifyWithReferee(): { checked: number; mismatches: number } {
    if (!this.exec.live) return { checked: 0, mismatches: 0 };
    const rows = this.db.prepare(`SELECT intent_id, trade_id, sweep, fold_outcome FROM live_trades WHERE fold_outcome IS NOT NULL AND referee_outcome IS NULL`).all() as
      { intent_id: string; trade_id: string; sweep: number; fold_outcome: string }[];
    let mismatches = 0;
    for (const r of rows) {
      const settled = this.db.prepare("SELECT n FROM settled_ids WHERE id = ?").get(r.trade_id) as { n: number } | undefined;
      const voided = this.db.prepare("SELECT n, reason FROM void_ids WHERE id = ? AND reason <> 'settled' ORDER BY n LIMIT 1").get(r.trade_id) as { n: number; reason: string } | undefined;
      const published = this.db.prepare("SELECT 1 FROM sweeps WHERE n = ? AND flow_json IS NOT NULL").get(r.sweep);
      let ref: string | null = null;
      if (settled) ref = "settled";
      else if (voided) ref = `void:${voided.reason}`;
      else if (published) ref = "unlisted";
      if (!ref) continue;
      const bad = (ref === "settled" && r.fold_outcome !== "settled") || (ref.startsWith("void") && r.fold_outcome === "settled");
      this.db.prepare("UPDATE live_trades SET referee_outcome = ?, referee_at = ?, updated_at = ? WHERE intent_id = ?").run(ref, now(), now(), r.intent_id);
      ccLog("LIVE RESULT", { trade_id: r.trade_id, sweep: r.sweep, fold: r.fold_outcome, referee: ref, agree: !bad });
      if (bad) {
        mismatches++;
        recordReconcile(this.db, r.sweep, "L3-referee-vs-fold", "MISMATCH", { trade_id: r.trade_id, fold: r.fold_outcome, referee: ref });
        halt(this.db, "reconcile_mismatch", `our trade ${r.trade_id}: fold ${r.fold_outcome}, referee ${ref} (sweep ${r.sweep})`, this.alerts ?? undefined);
      }
    }
    return { checked: rows.length, mismatches };
  }

  private resolveEstimate(n: number, price: PricePost): void {
    const row = this.db.prepare("SELECT estimated_close FROM estimates WHERE n = ?").get(n) as { estimated_close: string } | undefined;
    const boundary = sweepTime(this.contest, n);
    const hlBefore = this.hl?.lastBefore(boundary) ?? null;
    const match = hlBefore ? hlBefore.tid === String(price.ref.tid) : null;
    const seen = this.hl?.hasTid(String(price.ref.tid)) ?? null;
    if (row) {
      const err = errorBps(toMicro(row.estimated_close), toMicro(price.ref.px));
      this.db.prepare(`UPDATE estimates SET actual_close = ?, actual_tid = ?, error = ?, error_bps = ?, hl_last_before_boundary = ?, hl_matches_ref = ?, resolved_at = ? WHERE n = ?`)
        .run(price.ref.px, String(price.ref.tid), fmtShort(toMicro(row.estimated_close) - toMicro(price.ref.px)), err,
          hlBefore ? `${hlBefore.px}@${hlBefore.tid}` : null, match === null ? null : match ? 1 : 0, now(), n);
      ccLog("ESTIMATE", { sweep: n, estimated_close: row.estimated_close, actual_close: price.ref.px, error_bps: err.toFixed(2),
        referee_tid: price.ref.tid, referee_time: price.ref.time, age_s: price.age_s, hl_last_before_boundary: hlBefore ? `${hlBefore.px}@${hlBefore.tid}` : null,
        hl_matches_referee: match, referee_trade_seen_by_us: seen });
    }
  }

  /** L2: every account of ours, official fold vs TypeScript mirror, exact. */
  async reconcileBooks(n: number | null, stage: string): Promise<boolean> {
    if (!this.minted) return true;
    const dids = this.allKeys().map((k) => k.did);
    const fa = await this.fold.accounts(dids);
    const diffs: string[] = [];
    for (const d of dids) {
      const f = fa.accounts[d];
      const t = this.ledger.accounts.get(d);
      if (!f || !t) { if (f || t) diffs.push(`${d}: present in only one book`); continue; }
      const lots = t.lots.map((l) => [fmtShort(l.qty), fmtShort(l.px)].join("@")).join(",");
      const flots = f.lots.map(([q, p]) => [fmtShort(toMicro(q)), fmtShort(toMicro(p))].join("@")).join(",");
      if (toMicro(f.cash) !== t.cash || toMicro(f.fees) !== t.fees || lots !== flots) diffs.push(`${d}: fold cash ${f.cash} fees ${f.fees} lots ${flots} vs mirror ${fmtShort(t.cash)} ${fmtShort(t.fees)} ${lots}`);
    }
    const status = diffs.length ? "MISMATCH" : "OK";
    recordReconcile(this.db, n, `L2-books-${stage}`, status, { accounts: dids.length, diffs: diffs.slice(0, 5) });
    ccLog(status === "OK" ? "RECONCILE OK" : "RECONCILE MISMATCH", { level: "L2 official fold vs mirror", stage, sweep: n, accounts: dids.length, fold_fees: fa.fees, diffs: diffs.length });
    if (diffs.length) this.halt(`L2 books mismatch (${stage}) at sweep ${n}`);
    return !diffs.length;
  }

  async summary(n: number, markPx: string): Promise<void> {
    const all = this.allKeys();
    const dids = all.map((k) => k.did);
    const fa = await this.fold.accounts(dids, markPx);
    const la = await this.lookFold.accounts(dids, markPx);
    const scores = all.map((k) => ({ id: k.id, score: fa.accounts[k.did]?.value ? Number(fa.accounts[k.did].value) - 10_000 : 0,
      look: la.accounts[k.did]?.value ? Number(la.accounts[k.did].value) - 10_000 : 0, pos: fa.accounts[k.did]?.position ?? "0" }));
    const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
    const snap = this.db.prepare(`INSERT OR REPLACE INTO positions (n, key_id, book, cash, position, fees, value, mark, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const k of all) {
      for (const [book, acc] of [[this.exec.live ? "live" : "paper", fa.accounts[k.did]], ["lookahead", la.accounts[k.did]]] as const) {
        if (acc && Number(acc.position) !== 0) snap.run(n, k.id, book, acc.cash, acc.position, acc.fees, acc.value, markPx, now());
      }
    }
    const active = scores.filter((s) => s.pos !== "0" && Number(s.pos) !== 0).length;
    ccLog("PAPER SUMMARY", { sweep: n, mark: markPx, keys: all.length, active, unused: all.length - active,
      pairs_used: this.state.nextPair, triggers: this.state.triggers, paper_fees: fa.fees, lookahead_fees: la.fees,
      paper_top3: top.map((t) => `${t.id}:${t.score.toFixed(2)}`), lookahead_top3: [...scores].sort((a, b) => b.look - a.look).slice(0, 3).map((t) => `${t.id}:${t.look.toFixed(2)}`),
      statuses: keyStatusCounts(this.db) });
  }
}

export function limitsFromRef(ref: Micro, contest: Contest): [Micro, Micro] {
  return limitsFor(ref, contest.limitWindow);
}
