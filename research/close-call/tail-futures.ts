/**
 * Upper tail of our BEST key at S, from the live state now, for the 80 virgin keys (research, read-only).
 *
 *   node --import tsx research/close-call/tail-futures.ts <paper DB backup> <now sweep> <now close> <K lo> <K hi> [paths=400]
 *
 * Futures: block bootstrap (2 h blocks) of the recorded sweeps, each keeping together the close-to-close return, OUR
 * estimator's error, the referee age_s and the Hyperliquid divergence (stale-policy inputs); plus higher-volatility
 * scenarios (log-returns x1.5 and x2). The information set is built exactly as loadInfo() builds it from a source DB
 * (checked on sample paths). Settlement: the Ledger mirror of the official fold (contra-sim.ts, engine-parity-checked).
 * "best" = the best of the NEW keys, and overall = with our existing K keys valued at S (fixed positions).
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import { loadCloseCallConfig } from "../../src/close-call/config.js";
import { loadContest } from "../../src/close-call/contest.js";
import { toMicro, type Micro } from "../../src/close-call/decimal.js";
import { foldParams } from "../../src/close-call/paper.js";
import { limitsFor } from "../../src/close-call/protocol.js";
import { decideStale } from "../../src/close-call/stale-policy.js";
import { ephemeralSigner } from "../../src/close-call/testing/ephemeral-signer.js";
import { makeSim, type ChampSpec, type Info, type Portfolio } from "./contra-sim.js";

const [src, nowS, closeS, loS, hiS, pathsS] = process.argv.slice(2);
const N0 = Number(nowS), P0 = Number(closeS), KLO = Number(loS), KHI = Number(hiS), PATHS = Number(pathsS ?? 400);
const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
const contest = loadContest(VENDOR);
const cfg = loadCloseCallConfig({ CLOSECALL_VENDOR_ROOT: VENDOR });
const LOCK = contest.lockSweep;

// our existing K keys (fixed positions, no more trades): score at S, from the live monitor (marked @1171 231.61; shorts @961 229.00)
const EXISTING = [
  { id: "CC009 long", s: (S: number) => 365.44 + 44.62 * (S - 231.61) },
  { id: "CC007 long", s: (S: number) => 338.20 + 44.5 * (S - 231.61) },
  { id: "CC001 long", s: (S: number) => 309.25 + 43.99 * (S - 231.61) },
  { id: "CC020 short", s: (S: number) => 151.06 - 41.96 * (S - 229.00) },
  { id: "CC018 short", s: (S: number) => 127.32 - 42.07 * (S - 229.00) },
];

const h = new Database(src, { readonly: true, fileMustExist: true });
const hist = h.prepare(`SELECT e.estimated_close est, e.hl_px, e.ref_prev, e.referee_age_s age, s.ref_px close, p.ref_px prev
  FROM estimates e JOIN sweeps s ON s.n = e.n JOIN sweeps p ON p.n = e.n - 1 WHERE e.estimated_close IS NOT NULL AND s.ref_px IS NOT NULL AND p.ref_px IS NOT NULL ORDER BY e.n`).all() as
  { est: string; hl_px: string | null; ref_prev: string | null; age: number | null; close: string; prev: string }[];
h.close();
const T = hist.map((r) => ({ ret: Number(r.close) / Number(r.prev), err: Number(r.est) / Number(r.close), hlRatio: r.hl_px && r.ref_prev ? Number(r.hl_px) / Number(r.ref_prev) : null, age: r.age ?? 0 }));

let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/** One future N0..LOCK as the Info list loadInfo() would build from its source DB (sweep N0 = the mint sweep). */
function path(volK: number): Info[] {
  const out: Info[] = [];
  const c0 = toMicro(P0.toFixed(2));
  out.push({ n: N0, close: c0, ref: c0, est: null, limits: limitsFor(c0, contest.limitWindow), policy: "TRADE" });
  let prev = P0, lastAge = 0, i = 24, start = 0;
  for (let n = N0 + 1; n <= LOCK; n++) {
    if (i >= 24) { start = Math.floor(rnd() * (T.length - 24)); i = 0; }
    const t = T[start + i++];
    const ret = Math.exp(volK * Math.log(t.ret));
    const close = Math.round(prev * ret * 100) / 100;
    const e = Math.round(close * t.err * 100) / 100;
    const refPrev = prev.toFixed(2), hlPx = t.hlRatio === null ? null : (prev * t.hlRatio).toFixed(2);
    const div = hlPx ? Math.abs(Number(hlPx) - Number(refPrev)) / Number(refPrev) * 10_000 : null;
    const policy = decideStale(cfg.stalePolicy, { ageS: lastAge, delayMin: 0, divergenceBps: div, refEstimated: false }).decision;
    const ref = toMicro(refPrev);
    out.push({ n, close: toMicro(close.toFixed(2)), ref, est: toMicro(e.toFixed(2)), limits: limitsFor(ref, contest.limitWindow), policy });
    lastAge = t.age;
    prev = close;
  }
  return out;
}

// ---- portfolios on the 80 virgin keys
const X = [0.0015, 0.002, 0.0025, 0.0035, 0.005];
const p = (x: number) => `${+(x * 100).toFixed(2)}`;
const ch = (x: number, dir: 1 | -1, cps: number): ChampSpec => ({ x, dir, cps });
const PF: Portfolio[] = [
  { name: "K 40 pairs", kPairs: 40, champs: [] },
  ...X.map((x) => ({ name: `K20 + 2ch ${p(x)} L/S (C1)`, kPairs: 20, champs: [ch(x, 1, 19), ch(x, -1, 19)] })),
  ...X.flatMap((x) => [{ name: `1ch ${p(x)} LONG +79`, kPairs: 0, champs: [ch(x, 1, 79)] }, { name: `1ch ${p(x)} SHORT +79`, kPairs: 0, champs: [ch(x, -1, 79)] }]),
  ...X.map((x) => ({ name: `2ch ${p(x)} L/S 39/39`, kPairs: 0, champs: [ch(x, 1, 39), ch(x, -1, 39)] })),
  { name: "4ch L.15 S.15 L.35 S.35", kPairs: 0, champs: [ch(0.0015, 1, 19), ch(0.0015, -1, 19), ch(0.0035, 1, 19), ch(0.0035, -1, 19)] },
  { name: "4ch L.2 S.2 L.5 S.5", kPairs: 0, champs: [ch(0.002, 1, 19), ch(0.002, -1, 19), ch(0.005, 1, 19), ch(0.005, -1, 19)] },
  { name: "4ch L.15 S.25 L.35 S.5", kPairs: 0, champs: [ch(0.0015, 1, 19), ch(0.0025, -1, 19), ch(0.0035, 1, 19), ch(0.005, -1, 19)] },
  { name: "4ch S.15 L.25 S.35 L.5", kPairs: 0, champs: [ch(0.0015, -1, 19), ch(0.0025, 1, 19), ch(0.0035, -1, 19), ch(0.005, 1, 19)] },
].map((x) => ({ ...x, kLo: KLO, kHi: KHI }));
const DIDS = Array.from({ length: 80 }, () => ephemeralSigner().did);
const sim = makeSim(cfg, foldParams(contest), DIDS);

const q = (xs: number[], pp: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * pp; const a = Math.floor(i), b = Math.ceil(i); return s[a] + (s[b] - s[a]) * (i - a); };
const pct = (xs: number[], f: (x: number) => boolean) => `${(100 * xs.filter(f).length / xs.length).toFixed(1)}%`.padStart(6);
const f0 = (x: number) => x.toFixed(0).padStart(6);

console.log(`from #${N0} at ${P0} to S (#${LOCK}, ${LOCK - N0} sweeps); K resumes at lo ${KLO} / hi ${KHI}; ${PATHS} paths per scenario; existing keys valued at S`);
for (const volK of [1, 1.5, 2]) {
  const res = new Map(PF.map((pf) => [pf.name, { neu: [] as number[], all: [] as number[], keys: [] as number[], exh: 0 }]));
  const S: number[] = [];
  const t0 = Date.now();
  for (let k = 0; k < PATHS; k++) {
    const info = path(volK);
    const s = Number(info[info.length - 1].close) / 1e6;
    S.push(s);
    const ex = Math.max(...EXISTING.map((e) => e.s(s)));
    for (const pf of PF) {
      const r = sim(pf, info);
      const o = res.get(pf.name)!;
      o.neu.push(r.best);
      o.all.push(Math.max(r.best, ex));
      o.keys.push(r.keysUsed);
      if (r.exhausted) o.exh++;
    }
  }
  const exist = S.map((s) => Math.max(...EXISTING.map((e) => e.s(s))));
  console.log(`\n=== scenario: ${volK === 1 ? "historical bootstrap" : `volatility x${volK}`} (${Math.round((Date.now() - t0) / 1000)} s) — S: p5 ${q(S, 0.05).toFixed(1)} median ${q(S, 0.5).toFixed(1)} p95 ${q(S, 0.95).toFixed(1)}; existing keys alone: P(>900) ${pct(exist, (x) => x > 900).trim()}, P(>1000) ${pct(exist, (x) => x > 1000).trim()}, P(>1200) ${pct(exist, (x) => x > 1200).trim()}, p99 ${q(exist, 0.99).toFixed(0)}`);
  console.log(`${"portfolio (80 new keys)".padEnd(28)} | NEW keys: P>900  P>1000  P>1200    p90    p95    p99    max | WITH existing: P>900  P>1000  P>1200    p99 | keys med/max  exhausted`);
  for (const pf of PF) {
    const o = res.get(pf.name)!;
    console.log(`${pf.name.padEnd(28)} |       ${pct(o.neu, (x) => x > 900)} ${pct(o.neu, (x) => x > 1000)} ${pct(o.neu, (x) => x > 1200)} ${[q(o.neu, 0.9), q(o.neu, 0.95), q(o.neu, 0.99), Math.max(...o.neu)].map(f0).join(" ")} |` +
      `            ${pct(o.all, (x) => x > 900)} ${pct(o.all, (x) => x > 1000)} ${pct(o.all, (x) => x > 1200)} ${f0(q(o.all, 0.99))} | ${String(Math.round(q(o.keys, 0.5))).padStart(3)}/${String(Math.max(...o.keys)).padEnd(3)}  ${o.exh}/${PATHS}`);
  }
}
