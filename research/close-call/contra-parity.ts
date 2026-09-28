/**
 * Parity: the ENGINE replay (src/close-call/replay.ts: PaperTrader + strategy/contra.ts + official fold) vs the
 * research simulator (contra-sim.ts), on the same windows and the same information set (the simulator reads the
 * replay's own recorded estimates / halts). Every CONTRA leg (sweep, keys, qty, px) and every key's final score
 * must match.
 *
 *   node --import tsx research/close-call/contra-parity.ts <paper DB backup>
 */

import { resolve } from "node:path";
import { loadCloseCallConfig } from "../../src/close-call/config.js";
import { loadContest } from "../../src/close-call/contest.js";
import { foldParams } from "../../src/close-call/paper.js";
import { engineReplay, replayScores } from "../../src/close-call/replay.js";
import { loadInfo, makeSim } from "./contra-sim.js";

const src = process.argv[2];
const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");
const contest = loadContest(VENDOR);
const ENV = { CLOSECALL_KEY_COUNT: "40", CLOSECALL_CONTRA_KEYS: "CC001-CC040", CLOSECALL_CONTRA_ENABLED: "true" };
const cfg = loadCloseCallConfig({ CLOSECALL_VENDOR_ROOT: VENDOR, ...ENV });
const windows: [number, number][] = [[150, 865], [300, 865], [400, 650], [500, 865], [650, 865]];

let allOk = true;
for (const [from, to] of windows) {
  const r = await engineReplay({ source: src, vendorRoot: VENDOR, contest, from, to, env: ENV });
  await r.advance();
  const eng = r.db.prepare(`SELECT sweep n, trigger, maker_id b, taker_id s, qty, px FROM intents WHERE risk_status = 'OK' AND trigger LIKE 'contra-%' ORDER BY sweep, created_at`).all() as
    { n: number; trigger: string; b: string; s: string; qty: string; px: string }[];
  const rejected = (r.db.prepare("SELECT COUNT(*) c FROM intents WHERE risk_status <> 'OK'").get() as { c: number }).c;
  const scoresE = replayScores(r);
  const idOf = new Map(r.trader.allKeys().map((k) => [k.did, k.id]));
  const dids = cfg.contra.keys.map((id) => r.trader.allKeys().find((k) => k.id === id)!.did);
  const info = loadInfo(r.db as never, cfg, contest).filter((i) => i.n >= from - 1 && i.n <= to);
  const sim = makeSim(cfg, foldParams(contest), dids)({ name: "B", kPairs: 0, champs: [{ x: cfg.contra.threshold, dir: 1, cps: 19 }, { x: cfg.contra.threshold, dir: -1, cps: 19 }] }, info);
  const e = eng.map((x) => `${x.n} ${x.trigger.split(":")[0]} ${x.b}>${x.s} ${x.qty}@${x.px}`);
  const s = sim.log.map((x) => `${x.n} ${x.role.split(":")[0]} ${idOf.get(x.buyer)}>${idOf.get(x.seller)} ${x.qty}@${x.px}`);
  const legsOk = JSON.stringify(e) === JSON.stringify(s);
  let maxDiff = 0;
  for (const [did, sc] of sim.scores) maxDiff = Math.max(maxDiff, Math.abs(sc - (scoresE.byKey.get(idOf.get(did)!) ?? 0)));
  const ok = legsOk && maxDiff < 1e-6;
  allOk &&= ok;
  console.log(`#${from}..#${to}: engine ${eng.length} legs (${rejected} rejected), sim ${sim.log.length} legs; legs ${legsOk ? "IDENTICAL" : "DIFFER"}; max |score diff| ${maxDiff.toFixed(6)}; best engine ${scoresE.best.id} ${scoresE.best.score.toFixed(2)}, sim ${idOf.get(sim.bestKey)} ${sim.best.toFixed(2)}  ${ok ? "OK" : "MISMATCH"}`);
  if (!legsOk) {
    for (let i = 0; i < Math.max(e.length, s.length); i++) if (e[i] !== s[i]) { console.log(`   first difference at leg ${i}: engine "${e[i]}" vs sim "${s[i]}"`); break; }
  }
  r.stop();
}
console.log(allOk ? "\nPARITY: engine replay == research simulator on every window" : "\nPARITY: MISMATCH (see above)");
