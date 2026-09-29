/**
 * CONTRA combinations on simulated FUTURES from the current sweep to the lock (no look-ahead): block bootstrap of the
 * recorded history in 2 h blocks, each block keeping together, sweep by sweep, the close-to-close return, OUR
 * estimator's error, the referee's age_s and the Hyperliquid/reference divergence (the stale-policy inputs).
 * Every path is written as a full source DB (referee price posts with timestamps + recorded estimates), consumed by
 * the research simulator (contra-sim.ts, parity-checked against the engine) and, on a sample, by the REAL engine
 * replay (must match exactly).
 *
 *   node --import tsx research/close-call/contra-futures.ts <paper DB backup> <current sweep> <current close> [paths=100]
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { loadCloseCallConfig } from "../../src/close-call/config.js";
import { loadContest, sweepTime } from "../../src/close-call/contest.js";
import { fmt2, toMicro } from "../../src/close-call/decimal.js";
import { RefereeObserver } from "../../src/close-call/observer.js";
import { foldParams } from "../../src/close-call/paper.js";
import { limitsFor, REFEREE_DID } from "../../src/close-call/protocol.js";
import { engineReplay, replayScores } from "../../src/close-call/replay.js";
import { openCloseCallDb } from "../../src/close-call/store.js";
import { ephemeralSigner } from "../../src/close-call/testing/ephemeral-signer.js";
import { loadInfo, makeSim, type Info, type Portfolio } from "./contra-sim.js";

const [src, nowS, closeS, pathsS] = process.argv.slice(2);
const N0 = Number(nowS), P0 = Number(closeS), PATHS = Number(pathsS ?? 100);
const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
const contest = loadContest(VENDOR);
const cfg = loadCloseCallConfig({ CLOSECALL_VENDOR_ROOT: VENDOR });
const P = foldParams(contest);
const LOCK = contest.lockSweep;

// ---- the recorded tuples
const h = new Database(src, { readonly: true, fileMustExist: true });
const hist = h.prepare(`SELECT e.n, e.estimated_close est, e.used, e.stale, e.hl_px, e.ref_prev, e.referee_age_s age, s.ref_px close, p.ref_px prev
  FROM estimates e JOIN sweeps s ON s.n = e.n JOIN sweeps p ON p.n = e.n - 1 WHERE e.estimated_close IS NOT NULL AND s.ref_px IS NOT NULL AND p.ref_px IS NOT NULL ORDER BY e.n`).all() as
  { n: number; est: string; used: string; stale: number; hl_px: string | null; ref_prev: string | null; age: number | null; close: string; prev: string }[];
const seedRow = h.prepare("SELECT text FROM raw_posts WHERE room = 'd-close1-price' AND text LIKE '%\"t\":\"seed\"%' LIMIT 1").get() as { text: string };
h.close();
const T = hist.map((r) => ({ ret: Number(r.close) / Number(r.prev), err: Number(r.est) / Number(r.close), used: r.used, stale: r.stale,
  hlRatio: r.hl_px && r.ref_prev ? Number(r.hl_px) / Number(r.ref_prev) : null, age: r.age ?? 0 }));

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const BLOCK = 24;

/** One simulated future N0..LOCK as a source DB; returns its path. */
function makePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "closecall-future-"));
  const path = join(dir, "future.sqlite3");
  const db = openCloseCallDb(path);
  const obs = new RefereeObserver(db, "http://unused.invalid", null);
  let seq = 0;
  const post = (n: number, body: Record<string, unknown>, ms: number) => obs.ingest("d-close1-price", 1, { seq: ++seq, ts: new Date(ms).toISOString(), from: REFEREE_DID, text: JSON.stringify(body) });
  post(0, JSON.parse(seedRow.text), sweepTime(contest, 1) - 60_000);
  let prev = P0;
  const price = (n: number, close: number, applied: number, age: number) => {
    const [lo, hi] = limitsFor(toMicro(close.toFixed(2)), contest.limitWindow);
    post(n, { t: "price", n, ref: { px: close.toFixed(2), tid: n, time: new Date(sweepTime(contest, n) - 1000).toISOString() }, limits: [fmt2(lo), fmt2(hi)],
      global: close.toFixed(2), file: `sim-${n}`, applied: applied.toFixed(2), for: n + 1, age_s: age }, sweepTime(contest, n) + 30_000);
  };
  price(N0, P0, P0, 0);
  const est = db.prepare(`INSERT INTO estimates (n, source, used, estimated_close, ref_prev, hl_px, hl_tid, hl_age_ms, referee_age_s, stale, decided_at) VALUES (?, 'combined', ?, ?, ?, ?, NULL, 0, ?, ?, ?)`);
  let i = BLOCK, start = 0, lastAge = 0;
  for (let n = N0 + 1; n <= LOCK; n++) {
    if (i >= BLOCK) { start = Math.floor(rnd() * (T.length - BLOCK)); i = 0; }
    const t = T[start + i++];
    const close = Math.round(prev * t.ret * 100) / 100;
    const e = Math.round(close * t.err * 100) / 100;
    est.run(n, t.used, e.toFixed(2), prev.toFixed(2), t.hlRatio === null ? null : (prev * t.hlRatio).toFixed(2), lastAge, t.stale, new Date(sweepTime(contest, n) - 20_000).toISOString());
    price(n, close, prev, t.age);
    lastAge = t.age;
    prev = close;
  }
  db.close();
  return path;
}

// ---- portfolios on the 40 keys
const pct2 = (x: number) => `${+(x * 100).toFixed(2)}`;
const PF: Portfolio[] = [{ name: "K 20 pairs (sim)", kPairs: 20, champs: [] }, { name: "L0.25/S0.25 19/19", kPairs: 0, champs: [{ x: 0.0025, dir: 1, cps: 19 }, { x: 0.0025, dir: -1, cps: 19 }] }];
for (const [a, b] of [[0.0025, 0.005], [0.0025, 0.0075], [0.0025, 0.01], [0.005, 0.0075], [0.005, 0.01]]) {
  for (const [lx, sx] of [[a, b], [b, a]]) {
    for (const [cl, cs] of [[19, 19], lx < sx ? [24, 14] : [14, 24]]) {
      PF.push({ name: `L${pct2(lx)}/S${pct2(sx)} ${cl}/${cs}`, kPairs: 0, champs: [{ x: lx, dir: 1, cps: cl }, { x: sx, dir: -1, cps: cs }] });
    }
  }
}
const DIDS = Array.from({ length: 40 }, () => ephemeralSigner().did);
const sim = makeSim(cfg, P, DIDS);

const HORIZONS = [250, 500, LOCK - N0];
type Res = { best: number; synced: boolean; used: number[]; exhausted: boolean };
const res = new Map<string, Map<number, Res[]>>();
for (const pf of PF) res.set(pf.name, new Map(HORIZONS.map((H) => [H, []])));

const t0 = Date.now();
const samples: string[] = [];
for (let k = 0; k < PATHS; k++) {
  const path = makePath();
  if (k < 3) samples.push(path);
  const d = new Database(path, { readonly: true });
  const info: Info[] = loadInfo(d, cfg, contest).filter((x) => x.n >= N0);
  d.close();
  for (const H of HORIZONS) {
    const w = info.filter((x) => x.n <= N0 + H);
    for (const pf of PF) {
      const r = sim(pf, w);
      res.get(pf.name)!.get(H)!.push({ best: r.best, synced: r.synced, used: r.cpsUsed, exhausted: r.exhausted > 0 });
    }
  }
  if ((k + 1) % 20 === 0) process.stderr.write(`  ${k + 1}/${PATHS} paths (${Math.round((Date.now() - t0) / 1000)} s)\n`);
}

// ---- report
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const a = Math.floor(i), b = Math.ceil(i); return s[a] + (s[b] - s[a]) * (i - a); };
const pct = (xs: number[], f: (x: number) => boolean) => `${Math.round(100 * xs.filter(f).length / xs.length)}%`.padStart(5);
const f0 = (x: number) => x.toFixed(0).padStart(6);
console.log(`futures: ${PATHS} bootstrap paths (2 h blocks of recorded history: return + estimator error + referee age + HL divergence), from #${N0} at ${P0} to the lock #${LOCK}`);
for (const H of HORIZONS) {
  const K = res.get(PF[0].name)!.get(H)!.map((x) => x.best), base = res.get(PF[1].name)!.get(H)!.map((x) => x.best);
  console.log(`\n=== futures, horizon ${H === LOCK - N0 ? `to S (${H} sweeps)` : `${H} sweeps`} ===`);
  console.log(`${"portfolio (40 keys)".padEnd(24)} median    p25    p75  worst   best    >K  >300  >400  >500   div.benefit med/p25/p75  cps used L/S med/max  exhausted  synced`);
  for (const pf of PF) {
    const rs = res.get(pf.name)!.get(H)!;
    const b = rs.map((x) => x.best);
    const div = b.map((x, j) => x - base[j]);
    const uL = rs.map((x) => x.used[0] ?? 0), uS = rs.map((x) => x.used[1] ?? 0);
    console.log(`${pf.name.padEnd(24)} ${[q(b, 0.5), q(b, 0.25), q(b, 0.75), Math.min(...b), Math.max(...b)].map(f0).join(" ")} ${pf === PF[0] ? "    -" : pct(b.map((x, j) => x - K[j]), (x) => x > 0)}` +
      ` ${pct(b, (x) => x > 300)} ${pct(b, (x) => x > 400)} ${pct(b, (x) => x > 500)}  ${pf === PF[0] || pf === PF[1] ? "              -" : `${f0(q(div, 0.5))}/${q(div, 0.25).toFixed(0)}/${q(div, 0.75).toFixed(0)}`.padStart(15)}` +
      `  ${pf === PF[0] ? "             -" : `${q(uL, 0.5)}/${Math.max(...uL)} ${q(uS, 0.5)}/${Math.max(...uS)}`.padStart(14)}  ${pf === PF[0] ? "-" : `${rs.filter((x) => x.exhausted).length}/${rs.length}`}  ${pf === PF[0] ? "-" : `${rs.filter((x) => x.synced).length}/${rs.length}`}`);
  }
}

// ---- the REAL engine on sample paths: must match the simulator exactly
console.log(`\n=== REAL engine replay on ${samples.length} simulated futures (horizon 500) vs the simulator ===`);
for (const [j, path] of samples.entries()) {
  for (const pf of [PF[1], PF.find((p) => p.name.startsWith("L0.25/S1 "))!]) {
    const env = { CLOSECALL_KEY_COUNT: "40", CLOSECALL_CONTRA_KEYS: "CC001-CC040", CLOSECALL_CONTRA_ENABLED: "true",
      CLOSECALL_CONTRA_THRESHOLD_LONG: String(pf.champs[0].x), CLOSECALL_CONTRA_THRESHOLD_SHORT: String(pf.champs[1].x),
      CLOSECALL_CONTRA_COUNTERPARTIES_LONG: String(pf.champs[0].cps), CLOSECALL_CONTRA_COUNTERPARTIES_SHORT: String(pf.champs[1].cps) };
    const r = await engineReplay({ source: path, vendorRoot: VENDOR, contest, from: N0 + 1, to: N0 + 500, env });
    await r.advance();
    const e = replayScores(r);
    const dids = Array.from({ length: 40 }, (_, i) => r.trader.allKeys().find((k) => k.id === `CC${String(i + 1).padStart(3, "0")}`)!.did);
    const d = new Database(r.db.name, { readonly: true });
    const info = loadInfo(d, cfg, contest).filter((x) => x.n >= N0 && x.n <= N0 + 500);
    d.close();
    const s = makeSim(cfg, P, dids)(pf, info);
    const idOf = new Map(r.trader.allKeys().map((k) => [k.did, k.id]));
    let maxDiff = 0;
    for (const [did, sc] of s.scores) maxDiff = Math.max(maxDiff, Math.abs(sc - (e.byKey.get(idOf.get(did)!) ?? 0)));
    console.log(`path ${j + 1} ${pf.name.padEnd(22)} engine best ${e.best.score.toFixed(2)}  sim best ${s.best.toFixed(2)}  max |diff| ${maxDiff.toFixed(6)}  ${maxDiff < 1e-6 ? "IDENTICAL" : "MISMATCH"}`);
    r.stop();
  }
}
