/**
 * The research simulator behind contra-analysis.ts, as an importable module, with the ENGINE's rules
 * (strategy/contra.ts + paper.ts) so that it can be checked against the engine replay:
 *   - counterparties consumed at the decision (1 per open, 2 per flip), whatever happens to the legs;
 *   - open/reopen legs keep CLOSECALL_CONTRA_RESERVE of cash on both sides; close legs keep none and are capped at
 *     the position;
 *   - a reopen that would still close part of the position (partial close) is refused, like the engine's no_flip check.
 * Settlement: the Ledger (the official fold's mirror). Decisions: the recorded estimate, never the close.
 */

import type Database from "better-sqlite3";
import type { CloseCallConfig } from "../../src/close-call/config.js";
import type { Contest } from "../../src/close-call/contest.js";
import { fmt2, toMicro, type Micro } from "../../src/close-call/decimal.js";
import { Ledger, type FoldParams, type WireTrade } from "../../src/close-call/ledger.js";
import { limitsFor, newTradeId } from "../../src/close-call/protocol.js";
import { closeBand, favoredPrice, maxPairQty } from "../../src/close-call/risk.js";
import { decideStale } from "../../src/close-call/stale-policy.js";

export type Dir = 1 | -1;
export interface Info { n: number; close: Micro; ref: Micro; est: Micro | null; limits: [Micro, Micro]; policy: "TRADE" | "REDUCE" | "HALT_NEW_ENTRIES" }
export interface ChampSpec { x: number; dir: Dir; cps: number }
export interface Portfolio { name: string; kPairs: number; kX?: number; champs: ChampSpec[] }
export interface SimTrade { n: number; role: string; buyer: string; seller: string; qty: string; px: string }
export interface RunOut {
  best: number; bestKey: string; scores: Map<string, number>; champScores: number[]; keysUsed: number; flips: number[]; cpsUsed: number[];
  exhausted: number; trades: WireTrade[][]; log: SimTrade[]; sweeps: Info[]; voids: Record<string, number>;
}

/** The information set per sweep, from a DB holding sweeps + estimates (+ stale-check halts). */
export function loadInfo(db: Database.Database, cfg: CloseCallConfig, contest: Contest): Info[] {
  const sweepRows = db.prepare("SELECT n, ref_px, applied, lim_lo, lim_hi, lim_for FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n").all() as
    { n: number; ref_px: string; applied: string | null; lim_lo: string | null; lim_hi: string | null; lim_for: number | null }[];
  const est = new Map((db.prepare("SELECT n, estimated_close, hl_px, ref_prev, referee_age_s FROM estimates WHERE estimated_close IS NOT NULL").all() as
    { n: number; estimated_close: string; hl_px: string | null; ref_prev: string | null; referee_age_s: number | null }[]).map((e) => [e.n, e]));
  const halted = new Set((db.prepare("SELECT sweep FROM strategy_triggers WHERE trigger = 'stale-check'").all() as { sweep: number }[]).map((r) => r.sweep));
  const byN = new Map(sweepRows.map((r) => [r.n, r]));
  const out: Info[] = [];
  for (const r of sweepRows) {
    const prev = byN.get(r.n - 1);
    const ref = r.applied ? toMicro(r.applied) : prev ? toMicro(prev.ref_px) : toMicro("226.14");
    const posted = prev && prev.lim_for === r.n && prev.lim_lo && prev.lim_hi ? [toMicro(prev.lim_lo), toMicro(prev.lim_hi)] as [Micro, Micro] : limitsFor(ref, contest.limitWindow);
    const e = est.get(r.n);
    let policy: Info["policy"] = "TRADE";
    if (e) {
      const div = e.hl_px && e.ref_prev ? Math.abs(Number(e.hl_px) - Number(e.ref_prev)) / Number(e.ref_prev) * 10_000 : null;
      policy = halted.has(r.n) ? "HALT_NEW_ENTRIES" : decideStale(cfg.stalePolicy, { ageS: e.referee_age_s, delayMin: 0, divergenceBps: div, refEstimated: false }).decision;
    }
    out.push({ n: r.n, close: toMicro(r.ref_px), ref, est: e ? toMicro(e.estimated_close) : null, limits: posted, policy });
  }
  return out;
}

const num = (m: Micro) => Number(m) / 1e6;

export function makeSim(cfg: CloseCallConfig, P: FoldParams, dids: string[]) {
  function pairTrade(l: Ledger, n: number, fav: string, cp: string, dir: Dir, info: Info, accepted: WireTrade[], reserve: number, cap?: Micro): WireTrade | null {
    const wide = info.policy === "REDUCE";
    const px = favoredPrice(dir > 0 ? "long" : "short", info.est!, wide ? cfg.stalePriceMargin : cfg.strategy.priceMargin, info.limits);
    const band = closeBand(info.est!, wide ? cfg.staleQtyMargin : cfg.strategy.qtyMargin);
    const l2 = l.clone();
    if (accepted.length) { l2.sweepN = n - 1; l2.sweep(n, info.ref, info.est!, [], accepted); }
    const buyer = dir > 0 ? fav : cp, seller = dir > 0 ? cp : fav;
    let q = maxPairQty(l2, l2.accounts.get(buyer)!, l2.accounts.get(seller)!, px, band, reserve);
    if (cap !== undefined && cap < q) q = cap;
    if (q < P.minQty) return null;
    return { id: newTradeId(), maker: buyer, side: "buy", qty: fmt2(q), px: fmt2(px), taker: seller, until: n, countersigner: seller };
  }

  return function run(pf: Portfolio, sweeps: Info[], keep = false): RunOut {
    const l = new Ledger(P);
    let next = 0;
    const takeKey = () => (next < dids.length ? dids[next++] : null);
    const champs = pf.champs.map((c) => {
      const did = takeKey()!;
      const pool: string[] = [];
      for (let i = 0; i < c.cps; i++) { const k = takeKey(); if (k) pool.push(k); }
      return { ...c, did, pool, used: 0, flips: 0, entry: 0, want: c.dir as Dir, exhausted: false };
    });
    const kKeys: string[] = [];
    for (let i = 0; i < pf.kPairs * 2; i++) { const k = takeKey(); if (k) kKeys.push(k); }
    let kNext = 0, lo = 0, hi = 0;
    const kx = pf.kX ?? cfg.strategy.threshold;
    const voids: Record<string, number> = {};
    const trades: WireTrade[][] = [];
    const log: SimTrade[] = [];
    let minted = false;
    for (const info of sweeps) {
      if (!minted) { l.sweep(info.n, info.ref, info.close, dids.slice(0, next), []); minted = true; trades.push([]); continue; }
      const out: WireTrade[] = [];
      const push = (t: WireTrade | null, role: string) => { if (t) { out.push(t); log.push({ n: info.n, role, buyer: t.maker, seller: t.countersigner, qty: t.qty, px: t.px }); } };
      if (info.est !== null && info.policy !== "HALT_NEW_ENTRIES") {
        const e = num(info.est);
        if (kKeys.length) {
          if (!lo) { lo = hi = e; }
          else {
            const dir: Dir | 0 = e >= hi * (1 + kx) ? -1 : e <= lo * (1 - kx) ? 1 : 0;
            if (dir && kNext + 1 < kKeys.length) {
              const t = pairTrade(l, info.n, kKeys[kNext], kKeys[kNext + 1], dir, info, out, cfg.strategy.reserve);
              if (t) { push(t, "K"); kNext += 2; if (dir < 0) hi = e; else lo = e; }
            }
          }
        }
        for (const [ci, c] of champs.entries()) {
          const pos = l.accounts.get(c.did)!.position;
          const name = c.dir > 0 ? "long" : "short";
          if (pos === 0n) {
            if (c.used >= c.pool.length) { c.exhausted = true; continue; }
            const t = pairTrade(l, info.n, c.did, c.pool[c.used], c.want, info, out, cfg.contra.reserve);
            push(t, `contra-${c.flips || c.used ? "reopen" : "open"}:${name}#${ci}`);
            c.used++; c.entry = e;
            continue;
          }
          const long = pos > 0n;
          const take = long ? e >= c.entry * (1 + c.x) : e <= c.entry * (1 - c.x);
          if (!take) continue;
          if (c.used + 2 > c.pool.length) { c.exhausted = true; continue; }
          const dir: Dir = long ? -1 : 1;
          const abs = long ? pos : -pos;
          const closeT = pairTrade(l, info.n, c.did, c.pool[c.used], dir, info, out, 0, abs);
          push(closeT, `contra-close:${name}#${ci}`);
          const closedAll = closeT !== null && toMicro(closeT.qty) === abs;
          const openT = closedAll ? pairTrade(l, info.n, c.did, c.pool[c.used + 1], dir, info, out, cfg.contra.reserve) : null;   // partial close -> reopen refused (no_flip)
          push(openT, `contra-reopen:${name}#${ci}`);
          c.used += 2; c.want = dir; c.entry = e; c.flips++;
        }
      }
      const res = l.sweep(info.n, info.ref, info.close, [], out);
      for (const o of res.outcomes) if (o.outcome === "void") voids[o.reason ?? "?"] = (voids[o.reason ?? "?"] ?? 0) + 1;
      trades.push(keep ? out : []);
    }
    const lastClose = sweeps[sweeps.length - 1].close;
    const scores = new Map<string, number>();
    for (const k of dids.slice(0, next)) scores.set(k, num(l.accounts.get(k)!.valueAt(lastClose)) - num(P.mint));
    let best = -Infinity, bestKey = "";
    for (const [k, s] of scores) if (s > best) { best = s; bestKey = k; }
    const keysUsed = champs.reduce((a, c) => a + 1 + c.used, 0) + kNext;
    return { best, bestKey, scores, champScores: champs.map((c) => scores.get(c.did)!), keysUsed, flips: champs.map((c) => c.flips), cpsUsed: champs.map((c) => c.used),
      exhausted: champs.filter((c) => c.exhausted).length, trades, log, sweeps, voids };
  };
}
