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
import { sweepTime, type Contest } from "./contest.js";
import { fmt2, fmtShort, max, toMicro, toNumber, type Micro } from "./decimal.js";
import { errorBps, estimateClose, type Estimate } from "./estimator.js";
import type { FoldSweepResult, OfficialFold } from "./fold.js";
import type { HyperliquidObserver } from "./hyperliquid.js";
import { Ledger, type FoldParams, type WireTrade } from "./ledger.js";
import { ccLog } from "./logger.js";
import { ensurePaperKeys, getKey, isTradable, keyStatusCounts, transitionKey, wouldSign, type KeyRecord } from "./keys.js";
import { canonicalTerms, limitsFor, makerSigningString, newTradeId, takerSigningString, termsFromTrade, tradeMessageText, type PricePost } from "./protocol.js";
import { closeBand, favoredPrice, maxPairQty, validateTrade } from "./risk.js";
import { decideStale } from "./stale-policy.js";
import { loadStrategyState, now, recordReconcile, saveStrategyState, type CcDb } from "./store.js";
import { halt, haltSummary } from "./safety.js";
import { strategyK, type KState, type StrategyIntent } from "./strategy/k-ladder.js";

interface PendingTrade { intentId: string; intent: StrategyIntent; wire: WireTrade; estimate: Micro; ref: string }

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
  keys: KeyRecord[] = [];
  minted = false;
  state: KState;
  private strategy;
  alerts: import("./alerts.js").Alerts | null = null;
  private pending = new Map<number, PendingTrade[]>();
  private ourIds = new Set<string>();

  constructor(private db: CcDb, private cfg: CloseCallConfig, private contest: Contest,
    readonly fold: OfficialFold, readonly lookFold: OfficialFold, private hl: HyperliquidObserver | null) {
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
    this.keys = ensurePaperKeys(this.db, this.cfg.strategy.keyCount, this.cfg.paperKeyPrefix);
    for (const k of this.keys) {
      if (k.status === "GENERATED") transitionKey(this.db, k.id, "REGISTER_PENDING", { reason: "paper: owner message WOULD be posted" });
    }
    this.keys = this.keys.map((k) => getKey(this.db, k.id));
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
    ccLog("KEYS", { count: this.keys.length, fake: true, first: this.keys[0]?.id, last: this.keys.at(-1)?.id, statuses: keyStatusCounts(this.db),
      replayed_sweeps: rows.length, minted: this.minted });
  }

  private rowToPending(i: Record<string, string>): PendingTrade {
    return {
      intentId: i.intent_id,
      intent: { pairIndex: Number(i.pair_index), favored: i.favored as "long" | "short", trigger: i.trigger as StrategyIntent["trigger"], triggerPx: 0, level: { lo: null, hi: null }, tries: 0 },
      wire: { id: i.trade_id, maker: i.maker_did, side: "buy", qty: i.qty, px: i.px, taker: i.taker_did, until: Number(i.until), countersigner: i.taker_did },
      estimate: toMicro(i.estimated_close),
      ref: i.ref,
    };
  }

  private sweepRow(n: number): SweepRow | undefined {
    return this.db.prepare("SELECT n, ref_px, ref_tid, applied, lim_lo, lim_hi, lim_for, age_s FROM sweeps WHERE n = ?").get(n) as SweepRow | undefined;
  }

  private ledgerForChecks(): Ledger {
    return this.ledger.clone();
  }

  private status(did: string): string | undefined {
    const k = this.keys.find((x) => x.did === did);
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
    const est = estimateClose(this.cfg.estimator, {
      lastRefPx: r?.ref ?? null, lastRefAgeS: r?.ageS ?? null,
      hl: this.hl?.latest ?? null, hlAgeMs: this.hl?.ageMs(nowMs) ?? null,
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
    const accepted: PendingTrade[] = [];
    const lchk = this.ledgerForChecks();
    const lim = limits ?? null;
    for (const intent of decision.intents) {
      const buyer = this.keys[2 * intent.pairIndex];
      const seller = this.keys[2 * intent.pairIndex + 1];
      if (!isTradable(this.status(buyer.did)) || !isTradable(this.status(seller.did))) {
        ccLog("RISK", { sweep: n, pair: intent.pairIndex, buyer: `${buyer.id}:${this.status(buyer.did)}`, seller: `${seller.id}:${this.status(seller.did)}` },
          "pair not tradable (keys must be READY or ACTIVE): intent dropped");
        st = this.strategy.onResult(st, intent.pairIndex, intent.favored, intent.trigger, intent.tries, false);
        continue;
      }
      const px = favoredPrice(intent.favored, est.value, priceMargin, lim ?? limitsFromRef(ref, this.contest));
      const band = closeBand(est.value, qtyMargin);
      const l2 = lchk.clone();
      if (accepted.length) {
        l2.sweepN = Math.min(l2.sweepN, n - 1);
        l2.sweep(n, ref, est.value, [], accepted.map((a) => a.wire));
      }
      const qty = maxPairQty(l2, l2.accounts.get(buyer.did)!, l2.accounts.get(seller.did)!, px, band, this.cfg.strategy.reserve);
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
      const intentId = `${n}-${intent.pairIndex}-${wire.id.slice(0, 8)}`;
      const status = risk.ok && foldOk ? "OK" : "REJECTED";
      const failed = [...risk.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ""}`), ...foldNotes];
      ccLog("PAPER INTENT", {
        sweep: n, pair: intent.pairIndex, trigger: intent.trigger, tries: intent.tries, favored: intent.favored,
        maker: buyer.id, maker_did: buyer.did, taker: seller.id, taker_did: seller.did, side: "buy", qty: wire.qty, px: wire.px, until,
        ref: prev.ref_px, ref_source: r.source, limits: lim ? [fmt2(lim[0]), fmt2(lim[1])] : "formula", estimated_close: fmtShort(est.value), estimator: est.used,
        price_margin: priceMargin, qty_margin: qtyMargin, threshold_trigger_px: intent.triggerPx,
        expected_maker_fee: risk.expected.makerFee, expected_taker_fee: risk.expected.takerFee,
        expected_maker_collateral: risk.expected.makerCollateral, expected_taker_collateral: risk.expected.takerCollateral,
        trade_id: wire.id, risk: status, failed: failed.length ? failed : undefined,
        maker_signature: "WOULD BE REQUIRED", taker_signature: "WOULD BE REQUIRED", post: "WOULD BE POSTED ONCE (complete trade)",
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
        const p: PendingTrade = { intentId, intent, wire, estimate: est.value, ref: prev.ref_px };
        accepted.push(p);
        this.ourIds.add(wire.id);
      } else {
        ccLog("RISK", { sweep: n, pair: intent.pairIndex, trade_id: wire.id, failed }, "intent blocked: it would not be sent");
        st = this.strategy.onResult(st, intent.pairIndex, intent.favored, intent.trigger, intent.tries, false);
      }
    }
    if (commit) {
      this.state = st;
      saveStrategyState(this.db, "K", this.state);
      if (accepted.length) this.pending.set(n, accepted);
    }
    return accepted;
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
    if (!this.minted) {
      await this.paperMint(n, refStr, close);
      return;
    }
    const pend = this.pending.get(n) ?? [];
    this.pending.delete(n);
    if (!pend.length) return;
    const owners: string[] = [];
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
      const buyer = this.keys[2 * p.intent.pairIndex];
      const seller = this.keys[2 * p.intent.pairIndex + 1];
      if (settled) {
        const role = (k: "buy" | "sell") => (k === "buy" ? (p.intent.favored === "long" ? "long*" : "long") : (p.intent.favored === "short" ? "short*" : "short"));
        for (const [k, side] of [[buyer, "buy"], [seller, "sell"]] as const) {
          transitionKey(this.db, k.id, "ACTIVE", { patch: { strategy_role: role(side), pair_index: p.intent.pairIndex, entry_reference: close, entry_sweep: n, entry_px: p.wire.px } });
        }
      }
      this.state = this.strategy.onResult(this.state, p.intent.pairIndex, p.intent.favored, p.intent.trigger, p.intent.tries, settled);
    }
    saveStrategyState(this.db, "K", this.state);
    await this.reconcileBooks(n, "settle");
    await this.summary(n, close);
  }

  /**
   * Paper registration: mint every paper key in the official fold at the first referee sweep we see,
   * with no trades. A key becomes MINT_CONFIRMED only for the DIDs the fold's sweep result lists in
   * `minted` (evidence source paper-fold), then READY. Trading starts at the NEXT decision.
   */
  private async paperMint(n: number, ref: string, close: string): Promise<void> {
    const owners = this.keys.map((k) => k.did);
    const res = (await this.fold.sweep(n, ref, close, owners, [])) as FoldSweepResult;
    this.ledger.sweep(n, toMicro(ref), toMicro(close), owners, []);
    const look = (await this.lookFold.sweep(n, ref, close, owners, [])) as FoldSweepResult;
    this.lookLedger.sweep(n, toMicro(ref), toMicro(close), owners, []);
    this.db.prepare(`INSERT OR REPLACE INTO paper_sweeps (n, ref, close, owners, trades, fold_result, lookahead_trades, lookahead_result, at)
      VALUES (?, ?, ?, ?, '[]', ?, '[]', ?, ?)`).run(n, ref, close, JSON.stringify(owners), JSON.stringify(res), JSON.stringify(look), now());
    const minted = new Set(res.minted);
    for (const k of this.keys) {
      if (!minted.has(k.did)) {
        ccLog("KEYS", { key: k.id, sweep: n }, "not in the fold's minted list: stays REGISTER_PENDING");
        continue;
      }
      transitionKey(this.db, k.id, "MINT_CONFIRMED", { evidence: { source: "paper-fold", sweep: n, detail: "official fold sweep result lists the DID in minted (paper)" } });
      transitionKey(this.db, k.id, "READY");
    }
    this.minted = minted.size > 0;
    this.keys = this.keys.map((k) => getKey(this.db, k.id));
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
    const dids = this.keys.map((k) => k.did);
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
    const dids = this.keys.map((k) => k.did);
    const fa = await this.fold.accounts(dids, markPx);
    const la = await this.lookFold.accounts(dids, markPx);
    const scores = this.keys.map((k) => ({ id: k.id, score: fa.accounts[k.did]?.value ? Number(fa.accounts[k.did].value) - 10_000 : 0,
      look: la.accounts[k.did]?.value ? Number(la.accounts[k.did].value) - 10_000 : 0, pos: fa.accounts[k.did]?.position ?? "0" }));
    const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
    const snap = this.db.prepare(`INSERT OR REPLACE INTO positions (n, key_id, book, cash, position, fees, value, mark, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const k of this.keys) {
      for (const [book, acc] of [["paper", fa.accounts[k.did]], ["lookahead", la.accounts[k.did]]] as const) {
        if (acc && Number(acc.position) !== 0) snap.run(n, k.id, book, acc.cash, acc.position, acc.fees, acc.value, markPx, now());
      }
    }
    const active = scores.filter((s) => s.pos !== "0" && Number(s.pos) !== 0).length;
    ccLog("PAPER SUMMARY", { sweep: n, mark: markPx, keys: this.keys.length, active, unused: this.keys.length - active,
      pairs_used: this.state.nextPair, triggers: this.state.triggers, paper_fees: fa.fees, lookahead_fees: la.fees,
      paper_top3: top.map((t) => `${t.id}:${t.score.toFixed(2)}`), lookahead_top3: [...scores].sort((a, b) => b.look - a.look).slice(0, 3).map((t) => `${t.id}:${t.look.toFixed(2)}`),
      statuses: keyStatusCounts(this.db) });
  }
}

export function limitsFromRef(ref: Micro, contest: Contest): [Micro, Micro] {
  return limitsFor(ref, contest.limitWindow);
}
