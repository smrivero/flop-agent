/**
 * Report of engine-combos.ts results (the REAL engine on rolling windows).
 *   node --import tsx research/close-call/combos-report.ts <dir with pf*.jsonl>
 * synced = at the window's end both champions hold the same side from the same anchor (the same bet twice).
 * diversification benefit = best key of the portfolio - best key of L0.25/S0.25 on the same window.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PORTFOLIOS } from "./engine-combos.js";

interface Row { pf: string; H: number | "end"; from: number; to: number; best: number; bestKey: string;
  champs: { name: string; score: number; flips: number; used: number; exhausted: boolean; pos: number; anchor: number | null }[] }
const dir = process.argv[2];
const rows: Row[] = readdirSync(dir).filter((f) => /^pf\d+\.jsonl$/.test(f)).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
const q = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p; const a = Math.floor(i), b = Math.ceil(i); return s[a] + (s[b] - s[a]) * (i - a); };
const pct = (xs: number[], f: (x: number) => boolean) => (xs.length ? `${Math.round(100 * xs.filter(f).length / xs.length)}%` : "-").padStart(5);
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-").padStart(6);
export const synced = (r: Row) => r.champs.length === 2 && r.champs.every((c) => c.pos !== 0) && Math.sign(r.champs[0].pos) === Math.sign(r.champs[1].pos) &&
  r.champs[0].anchor !== null && r.champs[0].anchor === r.champs[1].anchor;

for (const H of [250, 500, "end"] as const) {
  const at = (pf: number) => rows.filter((r) => r.pf === String(pf) && r.H === H).sort((a, b) => a.from - b.from);
  const K = at(0), base = at(1);
  if (!K.length) continue;
  console.log(`\n=== REAL engine, horizon ${H === "end" ? "to the last recorded sweep" : `${H} sweeps (${(H * 5 / 60).toFixed(1)} h)`}, ${K.length} windows ===`);
  console.log(`${"portfolio (40 keys)".padEnd(22)} median    p25    p75  worst   best    >K  >300  >400  >500  synced   div.benefit med/p25/p75   cps used L/S (med/max)  exhausted`);
  for (const [i, p] of PORTFOLIOS.entries()) {
    const w = at(i);
    if (!w.length) { console.log(`${p.name.padEnd(22)} (no result)`); continue; }
    const b = w.map((r) => r.best);
    const div = w.map((r, j) => r.best - (base[j]?.best ?? NaN)).filter(Number.isFinite);
    const cpsL = w.map((r) => r.champs[0]?.used ?? 0), cpsS = w.map((r) => r.champs[1]?.used ?? 0);
    console.log(`${p.name.padEnd(22)} ${[q(b, 0.5), q(b, 0.25), q(b, 0.75), Math.min(...b), Math.max(...b)].map(f0).join(" ")} ${i === 0 ? "    -" : pct(b.map((x, j) => x - K[j].best), (x) => x > 0)}` +
      ` ${pct(b, (x) => x > 300)} ${pct(b, (x) => x > 400)} ${pct(b, (x) => x > 500)}  ${i === 0 ? "     -" : `${w.filter(synced).length}/${w.length}`.padStart(6)}` +
      `   ${i <= 1 ? "              -" : `${f0(q(div, 0.5))}/${f0(q(div, 0.25)).trim()}/${f0(q(div, 0.75)).trim()}`.padStart(15)}` +
      `   ${i === 0 ? "              -" : `${q(cpsL, 0.5)}/${Math.max(...cpsL)} ${q(cpsS, 0.5)}/${Math.max(...cpsS)}`.padStart(15)}  ${i === 0 ? "-" : `${w.filter((r) => r.champs.some((c) => c.exhausted)).length}/${w.length}`}`);
  }
}
