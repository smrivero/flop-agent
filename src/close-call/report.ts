/**
 * `closecall:report`: what the paper run measured, from the local database only.
 *  - estimated_close vs actual close, per source: A (previous referee close), B (Hyperliquid at decision
 *    time), C (what the configured estimator used)
 *  - Hyperliquid's last trade before each boundary vs the referee's ref (does our feed see its trade?)
 *  - triggers, intents, risk rejections, settled / void (with reasons), expected vs actual fees
 *  - main book vs look-ahead book (the cost of not knowing the close)
 */

import type { CcDb } from "./store.js";

const bps = (a: number, b: number) => ((a - b) / b) * 10_000;

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, mean_abs_bps: null, max_abs_bps: null, mean_bps: null };
  const abs = xs.map(Math.abs);
  return { n: xs.length, mean_abs_bps: +(abs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2), max_abs_bps: +Math.max(...abs).toFixed(2),
    mean_bps: +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) };
}

export function report(db: CcDb) {
  const est = db.prepare("SELECT * FROM estimates WHERE actual_close IS NOT NULL ORDER BY n").all() as Record<string, string | number | null>[];
  const A = est.filter((e) => e.ref_prev).map((e) => bps(Number(e.ref_prev), Number(e.actual_close)));
  const B = est.filter((e) => e.hl_px).map((e) => bps(Number(e.hl_px), Number(e.actual_close)));
  const C = est.map((e) => Number(e.error_bps));
  const intents = db.prepare("SELECT * FROM intents ORDER BY sweep, pair_index").all() as Record<string, string | number | null>[];
  const settled = intents.filter((i) => i.outcome === "settled");
  const feeErr = settled.map((i) => ({
    sweep: i.sweep, pair: i.pair_index, favored: i.favored,
    maker_fee_expected: i.expected_maker_fee, maker_fee_actual: i.actual_maker_fee,
    taker_fee_expected: i.expected_taker_fee, taker_fee_actual: i.actual_taker_fee,
    estimated_close: i.estimated_close, actual_close: i.actual_close, lookahead: i.lookahead_outcome,
  }));
  const reasons: Record<string, number> = {};
  for (const i of intents.filter((x) => x.outcome === "void")) reasons[String(i.reason)] = (reasons[String(i.reason)] ?? 0) + 1;
  const state = db.prepare("SELECT json FROM strategy_state WHERE name = 'K'").get() as { json: string } | undefined;
  const k = state ? JSON.parse(state.json) : null;
  const refs = est.map((e) => ({ n: e.n, estimated: e.estimated_close, used: e.used, actual: e.actual_close, hl_at_decision: e.hl_px,
    hl_last_before_boundary: e.hl_last_before_boundary, hl_matches_referee: e.hl_matches_ref, referee_age_s_at_decision: e.referee_age_s }));
  const recon = db.prepare("SELECT level, status, COUNT(*) n FROM reconcile GROUP BY level, status ORDER BY level").all();
  return {
    estimates: { A_previous_referee_close: stats(A), B_hyperliquid_at_decision: stats(B), C_used_by_estimator: stats(C), per_sweep: refs },
    strategy: { triggers: k?.triggers ?? 0, pairs_used: k?.nextPair ?? 0, lo: k?.lo, hi: k?.hi, retries_queued: k?.retries?.length ?? 0 },
    intents: {
      total: intents.length, risk_ok: intents.filter((i) => i.risk_status === "OK").length,
      risk_rejected: intents.filter((i) => i.risk_status === "REJECTED").length,
      settled: settled.length, void: intents.filter((i) => i.outcome === "void").length, void_reasons: reasons,
      pending: intents.filter((i) => i.risk_status === "OK" && !i.outcome).length,
      mirror_agreed: intents.filter((i) => i.outcome && i.ts_predicted_outcome === (i.outcome + (i.reason ? ":" + i.reason : ""))).length,
    },
    fees: feeErr,
    reconcile: recon,
  };
}
