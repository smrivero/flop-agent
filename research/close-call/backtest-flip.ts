/**
 * Offline backtest (read-only): Strategy K (ladder, one trade per key, hold) vs FLIP (one champion key that
 * closes and reverses on an x% retracement, zero-cost when favoured), through the OFFICIAL fold on the real
 * referee closes recorded in a paper DB backup. No network, no key, nothing written anywhere.
 *
 *   node --import tsx research/close-call/backtest-flip.ts <paper DB backup .sqlite3>
 *
 * Simplifications (stated in the output): the decision uses the sweep's actual close as its estimate (live uses
 * Hyperliquid ~20 s before the boundary); favoured prices keep a 0.1% margin over the 1% fee; every leg uses a
 * fresh counterparty key (100 keys total per run); sizes are capped by what a fresh 10,000 POLF key can take.
 */

import { resolve } from "node:path";
import Database from "better-sqlite3";
import { OfficialFold } from "../../src/close-call/fold.js";
import { loadContest } from "../../src/close-call/contest.js";
import { foldConfig } from "../../src/close-call/paper.js";
import { newTradeId } from "../../src/close-call/protocol.js";
import type { WireTrade } from "../../src/close-call/ledger.js";
import { ephemeralSigner } from "../../src/close-call/testing/ephemeral-signer.js";

const dbPath = process.argv[2];
if (!dbPath) { console.error("usage: backtest-flip.ts <paper DB backup>"); process.exit(2); }
const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
const contest = loadContest(VENDOR);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare("SELECT n, ref_px, applied, mark FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n").all() as
  { n: number; ref_px: string; applied: string | null; mark: string | null }[];
const seedPx = (db.prepare("SELECT price FROM seed WHERE id = 1").get() as { price: string } | undefined)?.price ?? "226.14";
const lastMark = [...rows].reverse().find((r) => r.mark)?.mark ?? null;
const last = rows[rows.length - 1];
console.log(`data: ${rows.length} sweeps ${rows[0].n}..${last.n}, seed ${seedPx}, last close ${last.ref_px}, referee mark ${lastMark}`);
console.log(`closes: min ${Math.min(...rows.map((r) => +r.ref_px))} max ${Math.max(...rows.map((r) => +r.ref_px))}\n`);

const floor2 = (x: number) => (Math.floor(x * 100 + 1e-9) / 100).toFixed(2);
const ceil2 = (x: number) => (Math.ceil(x * 100 - 1e-9) / 100).toFixed(2);
const favPx = (dir: 1 | -1, c: number) => (dir > 0 ? floor2(c / 1.011) : ceil2(c / 0.989));   // 1% fee + 0.1% margin
const capQty = (px: number) => floor2(10_000 / (px * 1.06));

interface Champ { did: string; pos: number; qty: string; peak: number; trough: number; legs: number; flips: number }
type Decide = (n: number, c: number, take: () => string | null, champ: Champ) => WireTrade[];

/** A favoured trade: `fav` gets `dir` (+1 buys, -1 sells) at a price that nets it exactly the close. */
function favoured(fav: string, cp: string, dir: 1 | -1, qty: string, c: number, n: number): WireTrade {
  return { id: newTradeId(), maker: fav, side: dir > 0 ? "buy" : "sell", qty, px: favPx(dir, c), taker: cp, until: n, countersigner: cp };
}

async function run(name: string, startN: number, decide: Decide): Promise<void> {
  const fold = await OfficialFold.start("python3", VENDOR, foldConfig(contest));
  try {
    await fold.seed(seedPx);
    const dids = Array.from({ length: 100 }, () => ephemeralSigner().did);
    let next = 1;                                                     // dids[0] = the champion (FLIP)
    const take = () => (next < dids.length ? dids[next++] : null);
    const champ: Champ = { did: dids[0], pos: 0, qty: "0", peak: 0, trough: 0, legs: 0, flips: 0 };
    const voids: Record<string, number> = {};
    let prevClose = seedPx;
    let minted = false;
    for (const r of rows) {
      const ref = r.applied ?? prevClose;
      prevClose = r.ref_px;
      if (r.n < startN) { await fold.sweep(r.n, ref, r.ref_px, [], []); continue; }
      const owners = minted ? [] : dids;
      minted = true;
      const res = await fold.sweep(r.n, ref, r.ref_px, owners, decide(r.n, Number(r.ref_px), take, champ));
      for (const t of res.trades) if (t.outcome === "void") voids[t.reason ?? "?"] = (voids[t.reason ?? "?"] ?? 0) + 1;
    }
    const at = async (mark: string) => {
      const { accounts } = await fold.accounts(dids, mark);
      const scores = dids.map((d) => ({ d, s: accounts[d]?.value ? Number(accounts[d].value) - 10_000 : 0 })).sort((a, b) => b.s - a.s);
      return { best: scores[0].s, champion: scores.find((x) => x.d === champ.did)!.s };
    };
    const c = await at(last.ref_px);
    const m = lastMark ? await at(lastMark) : null;
    console.log(`${name.padEnd(24)} from #${String(startN).padEnd(4)} keys ${String(next).padStart(3)}  flips ${String(champ.flips).padStart(3)}  ` +
      `best@close ${c.best.toFixed(2).padStart(8)}  best@mark ${m ? m.best.toFixed(2).padStart(8) : "     n/a"}  champion@mark ${m ? m.champion.toFixed(2).padStart(8) : "n/a"}` +
      `${Object.keys(voids).length ? `  voids ${JSON.stringify(voids)}` : ""}`);
  } finally {
    fold.stop();
  }
}

/** Strategy K (approximation): split start (one favoured long + one favoured short), then a pair on each new extreme. */
const K = (x: number): Decide => {
  let lo = 0, hi = 0;
  return (n, c, take) => {
    const out: WireTrade[] = [];
    const pair = (dir: 1 | -1) => { const a = take(), b = take(); if (a && b) out.push(favoured(a, b, dir, capQty(c), c, n)); };
    if (!lo) { lo = hi = c; pair(1); pair(-1); return out; }
    if (c >= hi * (1 + x)) { pair(-1); hi = c; } else if (c <= lo * (1 - x)) { pair(1); lo = c; }
    return out;
  };
};

/** FLIP: one champion; reverses when the close retraces x from the best close since its entry. */
const FLIP = (x: number, startDir: 1 | -1): Decide => (n, c, take, ch) => {
  const out: WireTrade[] = [];
  if (ch.legs === 0) {
    const cp = take(); if (!cp) return out;
    ch.qty = capQty(c); ch.pos = startDir; ch.peak = ch.trough = c; ch.legs++;
    out.push(favoured(ch.did, cp, startDir, ch.qty, c, n));
    return out;
  }
  ch.peak = Math.max(ch.peak, c); ch.trough = Math.min(ch.trough, c);
  const reverse = ch.pos > 0 ? c <= ch.peak * (1 - x) : c >= ch.trough * (1 + x);
  if (!reverse) return out;
  const cp1 = take(), cp2 = take();
  if (!cp1 || !cp2) return out;                                         // out of counterparties: hold
  const dir = (ch.pos > 0 ? -1 : 1) as 1 | -1;
  const q = capQty(c);
  out.push(favoured(ch.did, cp1, dir, ch.qty, c, n));                    // close
  out.push(favoured(ch.did, cp2, dir, q, c, n));                         // open the other way
  ch.qty = q; ch.pos = dir; ch.peak = ch.trough = c; ch.legs += 2; ch.flips++;
  return out;
};

/** CONTRA: one champion takes profit after an x move IN its favour from entry and reverses (harvests a range). */
const CONTRA = (x: number, startDir: 1 | -1): Decide => (n, c, take, ch) => {
  const out: WireTrade[] = [];
  if (ch.legs === 0) {
    const cp = take(); if (!cp) return out;
    ch.qty = capQty(c); ch.pos = startDir; ch.peak = ch.trough = c; ch.legs++;
    out.push(favoured(ch.did, cp, startDir, ch.qty, c, n));
    return out;
  }
  const entry = ch.peak;                                                  // peak = entry close here
  const reverse = ch.pos > 0 ? c >= entry * (1 + x) : c <= entry * (1 - x);
  if (!reverse) return out;
  const cp1 = take(), cp2 = take();
  if (!cp1 || !cp2) return out;
  const dir = (ch.pos > 0 ? -1 : 1) as 1 | -1;
  const q = capQty(c);
  out.push(favoured(ch.did, cp1, dir, ch.qty, c, n));
  out.push(favoured(ch.did, cp2, dir, q, c, n));
  ch.qty = q; ch.pos = dir; ch.peak = ch.trough = c; ch.legs += 2; ch.flips++;
  return out;
};

console.log("assumptions: decision at the actual close; favoured px = close/1.011 (buy) or close/0.989 (sell); a fresh counterparty per leg; 100 keys\n");
for (const start of [1, 372]) {
  await run("K x=0.25%", start, K(0.0025));
  for (const x of [0.0025, 0.005, 0.01, 0.02]) {
    await run(`FLIP ${(x * 100).toFixed(2)}% start long`, start, FLIP(x, 1));
    await run(`FLIP ${(x * 100).toFixed(2)}% start short`, start, FLIP(x, -1));
  }
  for (const x of [0.0025, 0.005, 0.0075, 0.01, 0.015]) {
    await run(`CONTRA ${(x * 100).toFixed(2)}% start long`, start, CONTRA(x, 1));
    await run(`CONTRA ${(x * 100).toFixed(2)}% start short`, start, CONTRA(x, -1));
  }
  console.log("");
}
console.log("live check: our real best at sweep 873 was CC009 +240.06 at mark 228.80 (K from #372); the published #25 needed > 410.57");
