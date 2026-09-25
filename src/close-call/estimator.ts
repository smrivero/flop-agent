/**
 * estimated_close: our guess of sweep n's close BEFORE the sweep, when we must sign.
 *
 * The fee-optimal price depends on the close c, which the referee only fixes at the
 * boundary (the last Hyperliquid trade before it). Using the real c to choose a
 * price would be look-ahead bias (see estimator.test.ts). Sources:
 *   ref       A: the last referee reference (sweep n-1's close)
 *   hl        B: the latest Hyperliquid xyz:NVDA trade we have seen
 *   combined  C: B when fresh and the referee is not stale; the last referee close
 *                when the referee has been reusing an old trade (it will likely
 *                reuse it again); A when Hyperliquid is stale or unavailable.
 * A stale situation also switches the risk engine to its wider margins.
 */

import type { EstimatorSource } from "./config.js";
import { fromNumber, toMicro, type Micro } from "./decimal.js";
import type { HlTrade } from "./hyperliquid.js";

export interface EstimateInput {
  lastRefPx: string | null;
  lastRefAgeS: number | null;
  hl: HlTrade | null;
  hlAgeMs: number | null;
}

export interface Estimate {
  value: Micro;
  used: "ref" | "hl";
  stale: boolean;
  reason: string;
}

export function estimateClose(source: EstimatorSource, input: EstimateInput, hlStaleMs: number, refereeStaleAgeS: number): Estimate | null {
  const ref = input.lastRefPx ? toMicro(input.lastRefPx) : null;
  const hlFresh = !!input.hl && input.hlAgeMs !== null && input.hlAgeMs <= hlStaleMs;
  const hl = input.hl ? fromNumber(Number(input.hl.px), 2) : null;
  const refStale = (input.lastRefAgeS ?? 0) >= refereeStaleAgeS;
  if (source === "ref") {
    return ref === null ? null : { value: ref, used: "ref", stale: refStale, reason: "source=ref" };
  }
  if (source === "hl") {
    if (hl !== null) return { value: hl, used: "hl", stale: !hlFresh || refStale, reason: hlFresh ? "hl fresh" : "hl stale" };
    return ref === null ? null : { value: ref, used: "ref", stale: true, reason: "hl unavailable, fallback ref" };
  }
  if (refStale && ref !== null) return { value: ref, used: "ref", stale: true, reason: `referee stale (age_s=${input.lastRefAgeS}): expect reuse` };
  if (hlFresh && hl !== null) return { value: hl, used: "hl", stale: false, reason: "hl fresh" };
  if (ref !== null) return { value: ref, used: "ref", stale: true, reason: "hl stale/unavailable, fallback ref" };
  return null;
}

/** Signed error of an estimate against the real close, in basis points. */
export function errorBps(estimate: Micro, actual: Micro): number {
  return (Number(estimate - actual) / Number(actual)) * 10_000;
}
