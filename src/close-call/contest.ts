/**
 * close-1 constants and sweep clock, read from the vendored frozen contest.json.
 *
 * Sweep n closes at first_sweep + (n-1) * sweep_seconds (n = 1 .. lock_sweep). The
 * referee's reference for sweep n is Hyperliquid's last xyz:NVDA trade before that
 * boundary (verified live: n=22 ref.time 13:49:57.723 for boundary 13:50:00), and it
 * posts a few seconds after it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toMicro, type Micro } from "./decimal.js";

export interface Contest {
  contestId: string;
  openingMs: number;
  firstSweepMs: number;
  sweepMs: number;
  lockSweep: number;
  finalPriceMs: number;
  mint: Micro;
  minQty: Micro;
  limitWindow: Micro;
  feeRate: Micro;
  refereeRooms: string[];
  tradingRooms: string[];
  reservedRooms: string[];
}

export function loadContest(vendorRoot: string): Contest {
  const c = JSON.parse(readFileSync(join(vendorRoot, "contest.json"), "utf8"));
  if (c.fee_rule !== "clawback") throw new Error(`unsupported fee_rule ${c.fee_rule}`);
  return {
    contestId: c.contest_id,
    openingMs: Date.parse(c.opening),
    firstSweepMs: Date.parse(c.first_sweep),
    sweepMs: c.sweep_seconds * 1000,
    lockSweep: c.lock_sweep,
    finalPriceMs: Date.parse(c.final_price_time),
    mint: toMicro(c.mint),
    minQty: toMicro(c.min_qty),
    limitWindow: toMicro(c.limit_window),
    feeRate: toMicro(c.fee_rate),
    refereeRooms: c.rooms.referee,
    tradingRooms: c.rooms.trading,
    reservedRooms: c.rooms.reserved,
  };
}

/** Boundary time (ms) at which sweep n closes. */
export function sweepTime(contest: Contest, n: number): number {
  return contest.firstSweepMs + (n - 1) * contest.sweepMs;
}

/** The sweep a message stamped at `ms` will be applied in (the next boundary at or after it). */
export function sweepForTime(contest: Contest, ms: number): number {
  if (ms <= contest.firstSweepMs) return 1;
  return Math.ceil((ms - contest.firstSweepMs) / contest.sweepMs) + 1;
}

/** The last sweep whose boundary is <= ms (0 before the first sweep). */
export function lastClosedSweep(contest: Contest, ms: number): number {
  if (ms < contest.firstSweepMs) return 0;
  return Math.floor((ms - contest.firstSweepMs) / contest.sweepMs) + 1;
}
