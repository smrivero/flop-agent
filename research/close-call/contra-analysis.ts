/**
 * Offline, decision-oriented analysis of CONTRA vs Strategy K (read-only: a paper DB backup in, a report out).
 *
 *   node --import tsx research/close-call/contra-analysis.ts <paper DB backup .sqlite3>
 *
 * Same information set as live, sweep by sweep:
 *   - the decision price is OUR recorded estimate for that sweep (estimates.estimated_close: Hyperliquid before the
 *     boundary), never the sweep's close; the close only settles, through the fold mirror;
 *   - stale policy: decideStale() on the referee age_s / Hyperliquid divergence known then, plus the recorded
 *     stale-check halts; REDUCE widens the margins exactly as the engine does;
 *   - prices: favoredPrice() (fee-optimal from the estimate, 0.1% / 0.4% margin, clamped to the posted limits);
 *     sizes: maxPairQty() at every close in closeBand() (the engine's funds check); cent rounding; until = this sweep;
 *   - settlement: the Ledger (the line-by-line mirror of the official fold, L2-verified live); a sample of runs is
 *     replayed through the OFFICIAL Python fold at the end and must match to the micro-unit.
 * Not modelled: posting latency / post guard (live has had 0 LATE / NOT_POSTED trades), other players.
 * Scores are valued at the window's last CLOSE (what S settles on), not at the referee's global mark.
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import { loadCloseCallConfig } from "../../src/close-call/config.js";
import { loadContest } from "../../src/close-call/contest.js";
import { fmt2, toMicro, type Micro } from "../../src/close-call/decimal.js";
import { OfficialFold } from "../../src/close-call/fold.js";
import { Ledger, type WireTrade } from "../../src/close-call/ledger.js";
import { foldConfig, foldParams } from "../../src/close-call/paper.js";
import { limitsFor, newTradeId } from "../../src/close-call/protocol.js";
import { closeBand, favoredPrice, maxPairQty } from "../../src/close-call/risk.js";
import { decideStale } from "../../src/close-call/stale-policy.js";
import { ephemeralSigner } from "../../src/close-call/testing/ephemeral-signer.js";

const dbPath = process.argv[2];
if (!dbPath) { console.error("usage: contra-analysis.ts <paper DB backup>"); process.exit(2); }
const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
const contest = loadContest(VENDOR);
const cfg = loadCloseCallConfig({ CLOSECALL_VENDOR_ROOT: VENDOR });
const P = foldParams(contest);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// ------------------------------------------------------------------ the information set, per sweep
interface Info { n: number; close: Micro; ref: Micro; est: Micro | null; limits: [Micro, Micro]; policy: "TRADE" | "REDUCE" | "HALT_NEW_ENTRIES" }
const sweepRows = db.prepare("SELECT n, ref_px, applied, lim_lo, lim_hi, lim_for FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n").all() as
  { n: number; ref_px: string; applied: string | null; lim_lo: string | null; lim_hi: string | null; lim_for: number | null }[];
const est = new Map((db.prepare("SELECT n, estimated_close, hl_px, ref_prev, referee_age_s, error_bps FROM estimates WHERE estimated_close IS NOT NULL").all() as
  { n: number; estimated_close: string; hl_px: string | null; ref_prev: string | null; referee_age_s: number | null; error_bps: number | null }[]).map((e) => [e.n, e]));
const halted = new Set((db.prepare("SELECT sweep FROM strategy_triggers WHERE trigger = 'stale-check'").all() as { sweep: number }[]).map((r) => r.sweep));
const byN = new Map(sweepRows.map((r) => [r.n, r]));
const REAL: Info[] = [];
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
  REAL.push({ n: r.n, close: toMicro(r.ref_px), ref, est: e ? toMicro(e.estimated_close) : null, limits: posted, policy });
}
const errBps = [...est.values()].map((e) => e.error_bps).filter((x): x is number => x !== null);
const withEst = REAL.filter((i) => i.est !== null);
const firstN = withEst[0].n, lastN = withEst[withEst.length - 1].n;

// ------------------------------------------------------------------ the engine: strategies on a shared key pool
const DIDS = Array.from({ length: 80 }, () => ephemeralSigner().did);
type Dir = 1 | -1;
interface ChampSpec { x: number; dir: Dir; cps: number }
interface Portfolio { name: string; kPairs: number; kX?: number; champs: ChampSpec[] }
interface Champ extends ChampSpec { did: string; pool: string[]; used: number; flips: number; entry: number; want: Dir; exhausted: boolean }
interface RunOut { best: number; bestKey: string; scores: Map<string, number>; champScores: number[]; keysUsed: number; flips: number[]; cpsUsed: number[]; exhausted: number; trades: WireTrade[][]; sweeps: Info[]; voids: Record<string, number> }

const num = (m: Micro) => Number(m) / 1e6;

function pairTrade(l: Ledger, n: number, fav: string, cp: string, dir: Dir, info: Info, accepted: WireTrade[], cap?: Micro): WireTrade | null {
  const wide = info.policy === "REDUCE";
  const px = favoredPrice(dir > 0 ? "long" : "short", info.est!, wide ? cfg.stalePriceMargin : cfg.strategy.priceMargin, info.limits);
  const band = closeBand(info.est!, wide ? cfg.staleQtyMargin : cfg.strategy.qtyMargin);
  const l2 = l.clone();
  if (accepted.length) { l2.sweepN = n - 1; l2.sweep(n, info.ref, info.est!, [], accepted); }
  const buyer = dir > 0 ? fav : cp, seller = dir > 0 ? cp : fav;
  let q = maxPairQty(l2, l2.accounts.get(buyer)!, l2.accounts.get(seller)!, px, band, cfg.strategy.reserve);
  if (cap !== undefined && cap < q) q = cap;
  if (q < P.minQty) return null;
  return { id: newTradeId(), maker: buyer, side: "buy", qty: fmt2(q), px: fmt2(px), taker: seller, until: n, countersigner: seller };
}

function run(pf: Portfolio, sweeps: Info[], keep = false): RunOut {
  const l = new Ledger(P);
  let next = 0;
  const takeKey = () => (next < DIDS.length ? DIDS[next++] : null);
  const champs: Champ[] = pf.champs.map((c) => {
    const did = takeKey()!;
    const pool: string[] = [];
    for (let i = 0; i < c.cps; i++) { const k = takeKey(); if (k) pool.push(k); }
    return { ...c, did, pool, used: 0, flips: 0, entry: 0, want: c.dir, exhausted: false };
  });
  const kKeys: string[] = [];
  for (let i = 0; i < pf.kPairs * 2; i++) { const k = takeKey(); if (k) kKeys.push(k); }
  let kNext = 0, lo = 0, hi = 0;
  const kx = pf.kX ?? cfg.strategy.threshold;
  const voids: Record<string, number> = {};
  const trades: WireTrade[][] = [];
  let minted = false;
  for (const info of sweeps) {
    const owners = minted ? [] : DIDS.slice(0, next);
    if (!minted) { l.sweep(info.n, info.ref, info.close, owners, []); minted = true; trades.push([]); continue; }
    const out: WireTrade[] = [];
    if (info.est !== null && info.policy !== "HALT_NEW_ENTRIES") {
      const e = num(info.est);
      // K ladder on new extremes (the already-open live pairs are not part of this simulation)
      if (kKeys.length) {
        if (!lo) { lo = hi = e; }
        else {
          const dir: Dir | 0 = e >= hi * (1 + kx) ? -1 : e <= lo * (1 - kx) ? 1 : 0;
          if (dir && kNext + 1 < kKeys.length) {
            const t = pairTrade(l, info.n, kKeys[kNext], kKeys[kNext + 1], dir, info, out);
            if (t) { out.push(t); kNext += 2; if (dir < 0) hi = e; else lo = e; }
          }
        }
      }
      for (const c of champs) {
        const acct = l.accounts.get(c.did)!;
        const pos = acct.position;
        if (pos === 0n) {                                              // flat: (re)open in the wanted direction
          const cp = c.pool[c.used];
          if (!cp) { c.exhausted = true; continue; }
          const t = pairTrade(l, info.n, c.did, cp, c.want, info, out);
          if (t) { out.push(t); c.used++; c.entry = e; }
          continue;
        }
        const long = pos > 0n;
        const take = long ? e >= c.entry * (1 + c.x) : e <= c.entry * (1 - c.x);
        if (!take) continue;
        if (c.used + 2 > c.pool.length) { c.exhausted = true; continue; }  // no counterparties left: hold
        const dir: Dir = long ? -1 : 1;
        const closeT = pairTrade(l, info.n, c.did, c.pool[c.used], dir, info, out, long ? pos : -pos);
        if (!closeT) continue;
        out.push(closeT);
        const openT = pairTrade(l, info.n, c.did, c.pool[c.used + 1], dir, info, out);
        c.used += openT ? 2 : 1;
        if (openT) out.push(openT);
        c.want = dir; c.entry = e; c.flips++;
      }
    }
    const res = l.sweep(info.n, info.ref, info.close, [], out);
    for (const o of res.outcomes) if (o.outcome === "void") voids[o.reason ?? "?"] = (voids[o.reason ?? "?"] ?? 0) + 1;
    trades.push(keep ? out : []);
  }
  const lastClose = sweeps[sweeps.length - 1].close;
  const scores = new Map<string, number>();
  for (const k of DIDS.slice(0, next)) scores.set(k, num(l.accounts.get(k)!.valueAt(lastClose)) - num(P.mint));
  let best = -Infinity, bestKey = "";
  for (const [k, s] of scores) if (s > best) { best = s; bestKey = k; }
  const keysUsed = champs.reduce((a, c) => a + 1 + c.used, 0) + kNext;
  return { best, bestKey, scores, champScores: champs.map((c) => scores.get(c.did)!), keysUsed, flips: champs.map((c) => c.flips), cpsUsed: champs.map((c) => c.used),
    exhausted: champs.filter((c) => c.exhausted).length, trades, sweeps, voids };
}

// ------------------------------------------------------------------ statistics
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const a = Math.floor(i), b = Math.ceil(i); return s[a] + (s[b] - s[a]) * (i - a); };
const pct = (xs: number[], f: (x: number) => boolean) => `${Math.round(100 * xs.filter(f).length / xs.length)}%`;
const f0 = (x: number) => x.toFixed(0).padStart(6);

function windows(H: number | "end", step = 25): Info[][] {
  const out: Info[][] = [];
  for (let s = firstN; ; s += step) {
    const end = H === "end" ? lastN : s + H;
    if (end > lastN || (H === "end" && lastN - s < 100)) break;
    out.push(REAL.filter((i) => i.n >= s && i.n <= end));
  }
  return out;
}

const HEAD = `${"strategy".padEnd(40)} keys(med/max)   median    p25    p75  worst   best   >0   >K  >300  >500  >623  flips(med)  exhausted`;
function report(pf: Portfolio, ws: Info[][], kBest: number[]): void {
  const runs = ws.map((w) => run(pf, w));
  const bests = runs.map((r) => r.best);
  const keys = runs.map((r) => r.keysUsed);
  const flips = runs.flatMap((r) => r.flips);
  console.log(`${pf.name.padEnd(40)} ${String(Math.round(q(keys, 0.5))).padStart(4)}/${String(Math.max(...keys)).padEnd(4)}  ${f0(q(bests, 0.5))} ${f0(q(bests, 0.25))} ${f0(q(bests, 0.75))} ${f0(Math.min(...bests))} ${f0(Math.max(...bests))}` +
    `  ${pct(bests, (x) => x > 0).padStart(4)} ${pct(bests.map((b, i) => b - kBest[i]), (x) => x > 0).padStart(4)} ${pct(bests, (x) => x > 300).padStart(5)} ${pct(bests, (x) => x > 500).padStart(5)} ${pct(bests, (x) => x > 623).padStart(5)}` +
    `  ${flips.length ? q(flips, 0.5).toFixed(0).padStart(9) : "        -"}  ${runs.filter((r) => r.exhausted > 0).length}/${runs.length}`);
}

// ------------------------------------------------------------------ portfolios (80 keys)
const T = [0.0025, 0.005, 0.0075, 0.01, 0.015];
const tl = (x: number) => (x * 100).toFixed(2);
const single = (x: number, dir: Dir): Portfolio => ({ name: `CONTRA ${tl(x)} ${dir > 0 ? "long" : "short"} (1 champ, 79 cps)`, kPairs: 0, champs: [{ x, dir, cps: 79 }] });
const champsOf = (xs: number[], cpsTotal: number): ChampSpec[] => {
  const specs = xs.flatMap((x) => [{ x, dir: 1 as Dir }, { x, dir: -1 as Dir }]);
  const each = Math.floor(cpsTotal / specs.length);
  return specs.map((s) => ({ ...s, cps: each }));
};
const PORTFOLIOS: Portfolio[] = [
  { name: "A  K 40 pairs (80 keys)", kPairs: 40, champs: [] },
  { name: "B1 CONTRA 0.25 L/S (2 champs, 39 cps each)", kPairs: 0, champs: champsOf([0.0025], 78) },
  { name: "B2 CONTRA 0.25+0.5 L/S (4 champs, 19 each)", kPairs: 0, champs: champsOf([0.0025, 0.005], 76) },
  { name: "B3 CONTRA 0.25..1.0 L/S (8 champs, 9 each)", kPairs: 0, champs: champsOf([0.0025, 0.005, 0.0075, 0.01], 72) },
  { name: "B4 CONTRA 0.25..1.5 L/S (10 champs, 7 each)", kPairs: 0, champs: champsOf(T, 70) },
  { name: "B5 CONTRA 0.5+1.0 L/S (4 champs, 19 each)", kPairs: 0, champs: champsOf([0.005, 0.01], 76) },
  { name: "B6 CONTRA 0.75+1.5 L/S (4 champs, 19 each)", kPairs: 0, champs: champsOf([0.0075, 0.015], 76) },
  { name: "C1 K 20 pairs + CONTRA 0.25 L/S (19 each)", kPairs: 20, champs: champsOf([0.0025], 38) },
  { name: "C2 K 20 pairs + CONTRA 0.25+0.5 L/S (9 each)", kPairs: 20, champs: champsOf([0.0025, 0.005], 36) },
  { name: "C3 K 10 pairs + CONTRA 0.25+0.5 L/S (14 each)", kPairs: 10, champs: champsOf([0.0025, 0.005], 56) },
];

// ------------------------------------------------------------------ report
console.log(`data: sweeps ${firstN}..${lastN} with a recorded estimate (${withEst.length}); estimator |error| median ${q(errBps.map(Math.abs), 0.5).toFixed(2)} bps, p95 ${q(errBps.map(Math.abs), 0.95).toFixed(2)} bps, max ${Math.max(...errBps.map(Math.abs)).toFixed(1)} bps`);
console.log(`policies: ${["TRADE", "REDUCE", "HALT_NEW_ENTRIES"].map((p) => `${p} ${REAL.filter((i) => i.est && i.policy === p).length}`).join(", ")}`);
console.log(`closes: ${Math.min(...REAL.map((i) => num(i.close)))}..${Math.max(...REAL.map((i) => num(i.close)))}; rolling starts every 25 sweeps; score = best key valued at the window's last close\n`);

for (const H of [250, 500, "end"] as const) {
  const ws = windows(H);
  const kBest = ws.map((w) => run(PORTFOLIOS[0], w).best);
  console.log(`=== horizon ${H === "end" ? `to #${lastN} (variable, >=100 sweeps)` : `${H} sweeps (${(H * 5 / 60).toFixed(1)} h)`}: ${ws.length} windows ===`);
  console.log(HEAD);
  console.log("-- single champion (item 2) --");
  for (const x of T) for (const d of [1, -1] as Dir[]) report(single(x, d), ws, kBest);
  console.log("-- portfolios on 80 keys (items 3-4) --");
  for (const pf of PORTFOLIOS) report(pf, ws, kBest);
  console.log("");
}

// ------------------------------------------------------------------ trend stress (item 5): monotone moves with real estimator errors
function synthetic(movePct: number, T = 600, seed = 7): Info[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out: Info[] = [];
  let prev = 228;
  for (let t = 0; t <= T; t++) {
    const base = 228 * (1 + movePct / 100 * t / T);
    const c = Math.max(1, base * (1 + (rnd() - 0.5) * 0.0004));     // +-2 bps noise: no retracement
    const e = c * (1 + errBps[Math.floor(rnd() * errBps.length)] / 10_000 * (rnd() < 0.5 ? -1 : 1));
    const ref = toMicro(prev.toFixed(2));
    out.push({ n: 1000 + t, close: toMicro(c.toFixed(2)), ref, est: toMicro(e.toFixed(2)), limits: limitsFor(ref, contest.limitWindow), policy: "TRADE" });
    prev = c;
  }
  return out;
}
console.log(`=== trend stress (item 5): 600 sweeps (50 h), monotone, +-2 bps noise, real estimator errors ===`);
console.log(`${"strategy".padEnd(40)} ${[-8, -5, -3, 3, 5, 8].map((m) => `${m > 0 ? "+" : ""}${m}%`.padStart(16)).join("")}`);
console.log(`${"".padEnd(40)} ${[-8, -5, -3, 3, 5, 8].map(() => "best / worst".padStart(16)).join("")}`);
for (const pf of [PORTFOLIOS[0], single(0.0025, 1), single(0.0025, -1), single(0.01, 1), single(0.01, -1), ...PORTFOLIOS.slice(1)]) {
  const cells = [-8, -5, -3, 3, 5, 8].map((m) => { const r = run(pf, synthetic(m)); const worst = Math.min(...r.scores.values()); return `${r.best.toFixed(0)} / ${worst.toFixed(0)}`.padStart(16); });
  console.log(`${pf.name.padEnd(40)} ${cells.join("")}`);
}

// ------------------------------------------------------------------ key consumption (item 6)
console.log(`\n=== key consumption (item 6), full real history #${firstN}..#${lastN} ===`);
console.log(`${"portfolio".padEnd(40)} champs  cps reserved  cps used (per champ)            flips (per champ)             keys used / 80  exhausted`);
for (const pf of PORTFOLIOS) {
  const r = run(pf, REAL.filter((i) => i.n >= firstN));
  console.log(`${pf.name.padEnd(40)} ${String(pf.champs.length).padStart(6)}  ${String(pf.champs.reduce((a, c) => a + c.cps, 0)).padStart(12)}  ${r.cpsUsed.join(",").padEnd(32)} ${r.flips.join(",").padEnd(29)} ${String(r.keysUsed).padStart(6)} / 80  ${r.exhausted}`);
}
console.log("when a champion runs out of counterparties it HOLDS its last position until S (no new flip); K stops opening pairs when its pairs are used.");

// ------------------------------------------------------------------ official fold cross-check
console.log(`\n=== cross-check: the Ledger mirror vs the OFFICIAL Python fold on 3 full runs ===`);
const fold = await OfficialFold.start(cfg.python, VENDOR, foldConfig(contest));
try {
  for (const pf of [PORTFOLIOS[0], PORTFOLIOS[2], PORTFOLIOS[8]]) {
    const r = run(pf, REAL.filter((i) => i.n >= firstN), true);
    await fold.reset(foldConfig(contest));
    await fold.seed("226.14");
    const used = [...r.scores.keys()];
    for (let i = 0; i < r.sweeps.length; i++) await fold.sweep(r.sweeps[i].n, fmt2(r.sweeps[i].ref), fmt2(r.sweeps[i].close), i === 0 ? used : [], r.trades[i]);
    const { accounts } = await fold.accounts(used, fmt2(r.sweeps[r.sweeps.length - 1].close));
    const diffs = used.filter((k) => Math.abs(Number(accounts[k].value) - 10_000 - r.scores.get(k)!) > 1e-6);
    console.log(`${pf.name.padEnd(40)} ${used.length} keys, ${r.trades.flat().length} trades: ${diffs.length ? `MISMATCH on ${diffs.length} keys` : "identical to the official fold"}  voids ${JSON.stringify(r.voids)}`);
  }
} finally {
  fold.stop();
}
