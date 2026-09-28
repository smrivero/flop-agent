/**
 * Decision table through the REAL engine (engine replay), rolling windows, for the three options on 80 fresh keys:
 *   A  Strategy K, 40 pairs          (CLOSECALL_KEY_COUNT=80)
 *   B  CONTRA only, 2 x (1 + 19)      (40 keys; the other 40 unused)
 *   C1 K 20 pairs + CONTRA 2 x (1+19) (CLOSECALL_KEY_COUNT=80, CLOSECALL_CONTRA_KEYS=CC041-CC080)
 * Score = best key of the portfolio at the window's last close. K here starts fresh (split start), as new pairs would.
 *
 *   node --import tsx research/close-call/engine-rolling.ts <paper DB backup> [step=25]
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import { loadContest } from "../../src/close-call/contest.js";
import { engineReplay, replayScores } from "../../src/close-call/replay.js";
import type { ContraState } from "../../src/close-call/strategy/contra.js";

const src = process.argv[2];
const step = Number(process.argv[3] ?? 25);
const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
const contest = loadContest(VENDOR);
const d = new Database(src, { readonly: true, fileMustExist: true });
const { lo, hi } = d.prepare("SELECT MIN(n) lo, MAX(n) hi FROM estimates WHERE estimated_close IS NOT NULL").get() as { lo: number; hi: number };
d.close();
const first = lo + 1;

const OPTIONS = [
  { name: "A  K 40 pairs", env: { CLOSECALL_KEY_COUNT: "80" } },
  { name: "B  CONTRA only 2x(1+19)", env: { CLOSECALL_KEY_COUNT: "40", CLOSECALL_CONTRA_KEYS: "CC001-CC040", CLOSECALL_CONTRA_ENABLED: "true" } },
  { name: "C1 K 20 pairs + CONTRA 2x(1+19)", env: { CLOSECALL_KEY_COUNT: "80", CLOSECALL_CONTRA_KEYS: "CC041-CC080", CLOSECALL_CONTRA_ENABLED: "true" } },
];
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const a = Math.floor(i), b = Math.ceil(i); return s[a] + (s[b] - s[a]) * (i - a); };
const pct = (xs: number[], f: (x: number) => boolean) => `${Math.round(100 * xs.filter(f).length / xs.length)}%`.padStart(5);

for (const H of [250, 500, "end"] as const) {
  const wins: [number, number][] = [];
  for (let s = first; ; s += step) {
    const e = H === "end" ? hi : s + H;
    if (e > hi || (H === "end" && hi - s < 100)) break;
    wins.push([s, e]);
  }
  const res: Record<string, { best: number[]; keys: number[]; flips: number[]; exhausted: number }> = {};
  for (const o of OPTIONS) {
    res[o.name] = { best: [], keys: [], flips: [], exhausted: 0 };
    for (const [from, to] of wins) {
      const r = await engineReplay({ source: src, vendorRoot: VENDOR, contest, from, to, env: o.env });
      await r.advance();
      const sc = replayScores(r);
      res[o.name].best.push(sc.best.score);
      const used = (r.db.prepare(`SELECT COUNT(DISTINCT k) n FROM (SELECT maker_id k FROM intents WHERE risk_status = 'OK' UNION SELECT taker_id FROM intents WHERE risk_status = 'OK')`).get() as { n: number }).n;
      res[o.name].keys.push(used);
      const st = r.trader.contraState as ContraState | null;
      if (st) { res[o.name].flips.push(...st.champions.map((c) => c.flips)); if (st.champions.some((c) => c.exhausted)) res[o.name].exhausted++; }
      r.stop();
    }
  }
  const K = res[OPTIONS[0].name].best;
  console.log(`\n=== ENGINE replay, horizon ${H === "end" ? `to #${hi}` : `${H} sweeps (${(H * 5 / 60).toFixed(1)} h)`}, ${wins.length} windows (starts every ${step}) ===`);
  console.log(`${"strategy".padEnd(34)} keys(med/max)  median    p25    p75  worst   best    >K  >300  >500  >623  flips(med/max)  exhausted`);
  for (const o of OPTIONS) {
    const b = res[o.name].best, k = res[o.name].keys, f = res[o.name].flips;
    console.log(`${o.name.padEnd(34)} ${String(Math.round(q(k, 0.5))).padStart(4)}/${String(Math.max(...k)).padEnd(6)} ${[q(b, 0.5), q(b, 0.25), q(b, 0.75), Math.min(...b), Math.max(...b)].map((x) => x.toFixed(0).padStart(6)).join(" ")}` +
      ` ${o === OPTIONS[0] ? "    -" : pct(b.map((x, i) => x - K[i]), (x) => x > 0)} ${pct(b, (x) => x > 300)} ${pct(b, (x) => x > 500)} ${pct(b, (x) => x > 623)}  ${f.length ? `${q(f, 0.5).toFixed(0)}/${Math.max(...f)}`.padStart(14) : "             -"}  ${res[o.name].exhausted}/${wins.length}`);
  }
}
