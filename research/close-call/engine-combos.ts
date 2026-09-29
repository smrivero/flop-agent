/**
 * One portfolio through the REAL engine (engine replay) on every rolling window; one JSON line per window.
 *   node --import tsx research/close-call/engine-combos.ts <paper DB backup> <portfolio index> <out.jsonl> [step=25]
 * Portfolios: 0 = K 20 pairs on the 40 keys (the alternative use of them); 1.. = two CONTRA champions on 40 keys.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { loadContest } from "../../src/close-call/contest.js";
import { engineReplay, replayScores } from "../../src/close-call/replay.js";
import type { ContraState } from "../../src/close-call/strategy/contra.js";

export const PORTFOLIOS: { name: string; long?: number; short?: number; cpsLong?: number; cpsShort?: number }[] = [
  { name: "K 20 pairs (40 keys)" },
  { name: "L0.25 / S0.25", long: 0.0025, short: 0.0025 },
  ...[[0.0025, 0.005], [0.0025, 0.0075], [0.0025, 0.01], [0.005, 0.0075], [0.005, 0.01]].flatMap(([a, b]) => [
    { name: `L${a * 100} / S${b * 100}`, long: a, short: b },
    { name: `L${b * 100} / S${a * 100}`, long: b, short: a },
  ]),
];

if (process.argv[1]?.endsWith("engine-combos.ts")) {
  const [src, idxS, out, stepS] = process.argv.slice(2);
  const pf = PORTFOLIOS[Number(idxS)];
  const step = Number(stepS ?? 25);
  const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
  const contest = loadContest(VENDOR);
  const d = new Database(src, { readonly: true, fileMustExist: true });
  const { lo, hi } = d.prepare("SELECT MIN(n) lo, MAX(n) hi FROM estimates WHERE estimated_close IS NOT NULL").get() as { lo: number; hi: number };
  d.close();
  const env: Record<string, string> = pf.long === undefined ? { CLOSECALL_KEY_COUNT: "40" } : {
    CLOSECALL_KEY_COUNT: "40", CLOSECALL_CONTRA_KEYS: "CC001-CC040", CLOSECALL_CONTRA_ENABLED: "true",
    CLOSECALL_CONTRA_THRESHOLD_LONG: String(pf.long), CLOSECALL_CONTRA_THRESHOLD_SHORT: String(pf.short),
    CLOSECALL_CONTRA_COUNTERPARTIES_LONG: String(pf.cpsLong ?? 19), CLOSECALL_CONTRA_COUNTERPARTIES_SHORT: String(pf.cpsShort ?? 19),
  };
  writeFileSync(out, "");
  for (const H of [250, 500, "end"] as const) {
    for (let s = lo + 1; ; s += step) {
      const e = H === "end" ? hi : s + H;
      if (e > hi || (H === "end" && hi - s < 100)) break;
      const r = await engineReplay({ source: src, vendorRoot: VENDOR, contest, from: s, to: e, env });
      await r.advance();
      const sc = replayScores(r);
      const st = r.trader.contraState as ContraState | null;
      const champs = st ? st.champions.map((c) => {
        const did = r.trader.allKeys().find((k) => k.id === c.champion)!.did;
        return { name: c.name, score: sc.byKey.get(c.champion) ?? 0, flips: c.flips, used: c.next, exhausted: c.exhausted, pos: Number(r.trader.ledger.accounts.get(did)?.position ?? 0n) / 1e6, anchor: c.anchor };
      }) : [];
      appendFileSync(out, JSON.stringify({ pf: idxS, H, from: s, to: e, best: sc.best.score, bestKey: sc.best.id, champs }) + "\n");
      r.stop();
    }
  }
}
