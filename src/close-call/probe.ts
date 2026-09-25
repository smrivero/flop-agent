/**
 * Idempotent mint probe (planning and resolution only; nothing is sent from here).
 *
 * A probe is a 0.10-contract trade between two of our keys at the reference price, with a
 * 128-bit random id persisted in `trades` before anything is signed. What the official fold
 * guarantees (probe.test.ts):
 *   - an id settles at most once, by anyone: re-posting the SAME signed trade can never
 *     create a second position (void:settled);
 *   - a void does not burn the id (not_owner, limits, funds): the same terms can still
 *     settle later while `until` has not passed -- so a new id for the same pair is only
 *     planned after the old `until` is over;
 *   - after `until`, re-posting is a pure query: void:settled if that id ever settled,
 *     void:expired if it never did (the settled check comes before the expiry check).
 * What it does NOT guarantee (the D case): the id becomes public the first time it is posted.
 * If that first attempt did not settle, anyone can settle their own trade under the same id,
 * and our later copy reads void:settled -- and the listed settled id is theirs, not ours.
 * So probe evidence is strong but not adversary-proof; see STRATEGY/README.
 *
 * Each new probe for a pair alternates direction, so if an "unresolved" earlier probe had in
 * fact settled, the pair's net position is 0, not 0.20.
 */

import { CENT, fmt2, floorTo, toMicro } from "./decimal.js";
import { newTradeId } from "./protocol.js";
import { now, type CcDb } from "./store.js";

export const PROBE_QTY = "0.10";

export interface ProbeTrade {
  trade_id: string; maker_id: string; taker_id: string; side: "buy" | "sell"; qty: string; px: string;
  sweep_first: number; until: number; status: string;
}

export type ProbeAction =
  | { kind: "wait"; why: string }
  | { kind: "repost-same"; why: string }
  | { kind: "query-repost"; why: string }
  | { kind: "resolved-settled"; sweep: number; caveat: string }
  | { kind: "resolved-void"; reason: string; sweep: number; retrySameId: boolean }
  | { kind: "resolved-never-settled"; sweep: number }
  | { kind: "ambiguous"; why: string };

export function planProbe(db: CcDb, p: { pairIds: [string, string]; sweep: number; ref: string; window?: number }): ProbeTrade {
  const prev = db.prepare(`SELECT * FROM trades WHERE kind = 'probe' AND ((maker_id = ? AND taker_id = ?) OR (maker_id = ? AND taker_id = ?))
    ORDER BY created_at DESC LIMIT 1`).get(p.pairIds[0], p.pairIds[1], p.pairIds[1], p.pairIds[0]) as ProbeTrade | undefined;
  if (prev && p.sweep <= prev.until && !["settled", "never-settled"].includes(prev.status)) {
    throw new Error(`probe ${prev.trade_id} is still live until sweep ${prev.until}: re-post it, do not create a new id`);
  }
  if (prev && prev.status === "settled") throw new Error(`pair already proven by probe ${prev.trade_id}`);
  const reverse = !!prev && prev.maker_id === p.pairIds[0];
  const t: ProbeTrade = {
    trade_id: newTradeId(), maker_id: reverse ? p.pairIds[1] : p.pairIds[0], taker_id: reverse ? p.pairIds[0] : p.pairIds[1],
    side: "buy", qty: PROBE_QTY, px: fmt2(floorTo(toMicro(p.ref), CENT)), sweep_first: p.sweep, until: p.sweep + (p.window ?? 6), status: "planned",
  };
  db.prepare(`INSERT INTO trades (trade_id, kind, sweep_first, until, maker_id, taker_id, side, qty, px, terms, status, created_at, updated_at)
    VALUES (?, 'probe', ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`).run(t.trade_id, t.sweep_first, t.until, t.maker_id, t.taker_id, t.side, t.qty, t.px, t.status, now(), now());
  return t;
}

/** What to do with a probe given what the referee has published so far. `currentSweep` is the last published sweep. */
export function resolveProbe(db: CcDb, t: ProbeTrade, currentSweep: number): ProbeAction {
  const settled = db.prepare("SELECT n FROM settled_ids WHERE id = ?").get(t.trade_id) as { n: number } | undefined;
  const voids = db.prepare("SELECT n, reason FROM void_ids WHERE id = ? ORDER BY n").all(t.trade_id) as { n: number; reason: string }[];
  const settledLater = voids.find((v) => v.reason === "settled");
  if (settled) {
    return { kind: "resolved-settled", sweep: settled.n,
      caveat: "an id is global: if an earlier attempt of ours had been voided and published, this listing could be someone else's copy" };
  }
  const expired = voids.find((v) => v.reason === "expired");
  if (expired) return { kind: "resolved-never-settled", sweep: expired.n };
  if (settledLater) {
    return { kind: "ambiguous", why: `void:settled at sweep ${settledLater.n} but the settlement itself was never listed: it proves only that SOME trade with this id settled` };
  }
  const lastVoid = voids.at(-1);
  if (lastVoid && lastVoid.n >= currentSweep - 1) {
    return { kind: "resolved-void", reason: lastVoid.reason, sweep: lastVoid.n, retrySameId: lastVoid.reason !== "shape" && currentSweep < t.until };
  }
  if (currentSweep <= t.until) return { kind: "repost-same", why: "no listed outcome yet (lists are truncated): re-post the identical signed trade" };
  return { kind: "query-repost", why: "until has passed: re-posting now can only read void:settled (it settled) or void:expired (it never did)" };
}
