/**
 * CONTRA shadow: the real engine (engine replay) running CONTRA on the LIVE feed, hypothetically: the live DB is
 * opened read-only (the estimates the live service records before each decision + the referee posts it receives),
 * the keys are fake, nothing is signed or sent, no lock is taken. It replays `warmup` sweeps of history, then follows
 * the live service sweep by sweep and prints, per champion: side, size, anchor, next trigger, hypothetical score,
 * flips, counterparties used -- next to our best REAL key (Strategy K) at the same close.
 */

import type { CloseCallConfig } from "./config.js";
import { lastClosedSweep, type Contest } from "./contest.js";
import { openReadonly } from "./monitor.js";
import { engineReplay, replayScores } from "./replay.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Our best real key right now: the service's last position snapshot re-marked at `close` (as the monitor does). */
function bestRealKey(liveDbPath: string, close: number): string {
  const { db, error } = openReadonly(liveDbPath);
  if (!db) return `n/a (${error})`;
  try {
    const n = (db.prepare("SELECT MAX(n) m FROM positions WHERE book = 'live'").get() as { m: number | null }).m;
    if (n === null) return "no live position yet";
    const rows = db.prepare("SELECT key_id, position, value, mark FROM positions WHERE n = ? AND book = 'live'").all(n) as { key_id: string; position: string; value: string; mark: string }[];
    const scored = rows.map((r) => ({ id: r.key_id, s: Number(r.value) + Number(r.position) * (close - Number(r.mark)) - 10_000 })).sort((a, b) => b.s - a.s);
    return scored.length ? `${scored[0].id} ${scored[0].s >= 0 ? "+" : ""}${scored[0].s.toFixed(2)}` : "none";
  } finally {
    db.close();
  }
}

export async function contraShadow(cfg: CloseCallConfig, contest: Contest, o: { warmup: number; minutes: number; from?: number; out: (s: string) => void }): Promise<void> {
  const from = o.from ?? lastClosedSweep(contest, Date.now()) + 1 - o.warmup;
  const env: Record<string, string> = {
    CLOSECALL_KEY_COUNT: String(2 + cfg.contra.counterparties.long + cfg.contra.counterparties.short),
    CLOSECALL_CONTRA_KEYS: `CC001-CC${String(2 + cfg.contra.counterparties.long + cfg.contra.counterparties.short).padStart(3, "0")}`,
    CLOSECALL_CONTRA_ENABLED: "true", CLOSECALL_CONTRA_THRESHOLD_LONG: String(cfg.contra.threshold.long), CLOSECALL_CONTRA_THRESHOLD_SHORT: String(cfg.contra.threshold.short),
    CLOSECALL_CONTRA_COUNTERPARTIES_LONG: String(cfg.contra.counterparties.long), CLOSECALL_CONTRA_COUNTERPARTIES_SHORT: String(cfg.contra.counterparties.short),
    CLOSECALL_CONTRA_RESERVE: String(cfg.contra.reserve), CLOSECALL_ESTIMATOR: cfg.estimator,
  };
  o.out(`CONTRA SHADOW (hypothetical: fake keys, nothing signed or sent, live DB read-only)  thresholds long ${(cfg.contra.threshold.long * 100).toFixed(2)}% / short ${(cfg.contra.threshold.short * 100).toFixed(2)}%  ` +
    `counterparties ${cfg.contra.counterparties.long}/${cfg.contra.counterparties.short}  reserve ${(cfg.contra.reserve * 100).toFixed(1)}%  warm-up from #${from}`);
  const r = await engineReplay({ source: cfg.liveDbPath, vendorRoot: cfg.vendorRoot, contest, from, env, python: cfg.python });
  const until = Date.now() + o.minutes * 60_000;
  let printedAt = -1;
  try {
    for (;;) {
      const decided = await r.advance();
      const last = r.decided.at(-1) ?? null;
      if (last !== null && (decided.length || printedAt !== last)) {
        printedAt = last;
        const sc = replayScores(r);
        const close = Number(sc.mark);
        const lines = r.trader.contraState!.champions.map((c) => {
          const did = r.trader.allKeys().find((k) => k.id === c.champion)!.did;
          const pos = Number(r.trader.ledger.accounts.get(did)?.position ?? 0n) / 1e6;
          const side = pos > 0 ? "LONG " : pos < 0 ? "SHORT" : "flat ";
          const x = cfg.contra.threshold[c.name];
          const trig = c.anchor === null ? "-" : pos > 0 ? `>= ${(c.anchor * (1 + x)).toFixed(2)} (take profit, go short)` : pos < 0 ? `<= ${(c.anchor * (1 - x)).toFixed(2)} (take profit, go long)` : "reopen next sweep";
          const s = sc.byKey.get(c.champion) ?? 0;
          return `  champion ${c.name.padEnd(5)} ${side} ${Math.abs(pos).toFixed(2).padStart(6)}  anchor ${c.anchor?.toFixed(2) ?? "-"}  next ${trig}\n` +
            `                  score ${s >= 0 ? "+" : ""}${s.toFixed(2)}  flips ${c.flips}  counterparties ${c.next}/${cfg.contra.counterparties[c.name]}${c.exhausted ? " EXHAUSTED (holding)" : ""}${c.pending.length ? `  pending ${c.pending.length}` : ""}`;
        });
        o.out(`\n#${last}  close ${sc.mark}  shadow best ${sc.best.id} ${sc.best.score >= 0 ? "+" : ""}${sc.best.score.toFixed(2)}  |  our best REAL key (K) ${bestRealKey(cfg.liveDbPath, close)}\n${lines.join("\n")}`);
      }
      if (Date.now() >= until) break;
      await sleep(10_000);
    }
  } finally {
    r.stop();
  }
}
