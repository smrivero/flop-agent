/**
 * What to do with NEW entries when the referee's data is stale or late.
 *
 *   TRADE             normal margins
 *   REDUCE            wide margins (less exposure, fewer voids)
 *   HALT_NEW_ENTRIES  no new pair and no retry this sweep; the ladder level is NOT consumed, so the
 *                     trigger fires again on fresh data if the market is still at the extreme
 *
 * adaptive (default): HALT_NEW_ENTRIES when the referee's last close is stale (age_s >= haltAgeS), when it
 * is publishing more than haltDelayMin late, or when Hyperliquid has moved more than haltDivergenceBps
 * from a stale reference; REDUCE when age_s >= reduceAgeS or the reference had to be estimated; else TRADE.
 *
 * Evidence (research/close-call/scripts/stale_policy.py, 1,440 seasons through the official fold, stale
 * episodes calibrated on 25 Sep): HALT_NEW_ENTRIES beat REDUCE by +4.6 / +5.1 POLF mean best score at
 * 40 / 100 keys (+44 / +46 on the ~10% of paths where it changes anything); TRADE ~= REDUCE. An entry
 * made while stale is priced at the OLD close, not at the market extreme that triggered it.
 */

import type { StalePolicyConfig } from "./config.js";

export type StaleDecision = "TRADE" | "REDUCE" | "HALT_NEW_ENTRIES";

export interface StaleInputs {
  ageS: number | null;            // referee age_s of the reference we will trade against
  delayMin: number;               // how late the referee is publishing (minutes past the boundary it has not posted)
  divergenceBps: number | null;   // |Hyperliquid latest - reference| in bps
  refEstimated: boolean;          // the reference had to be derived (referee post not there yet)
}

export function decideStale(cfg: StalePolicyConfig, i: StaleInputs): { decision: StaleDecision; reason: string } {
  if (cfg.mode !== "adaptive") return { decision: cfg.mode, reason: `fixed policy ${cfg.mode}` };
  const age = i.ageS ?? 0;
  const stale = age >= cfg.reduceAgeS;
  if (age >= cfg.haltAgeS) return { decision: "HALT_NEW_ENTRIES", reason: `referee age_s ${age} >= ${cfg.haltAgeS}` };
  if (i.delayMin >= cfg.haltDelayMin) return { decision: "HALT_NEW_ENTRIES", reason: `referee ${i.delayMin.toFixed(1)} min late >= ${cfg.haltDelayMin}` };
  if (stale && i.divergenceBps !== null && i.divergenceBps >= cfg.haltDivergenceBps) {
    return { decision: "HALT_NEW_ENTRIES", reason: `stale reference ${i.divergenceBps.toFixed(1)} bps from Hyperliquid` };
  }
  if (stale || i.refEstimated) return { decision: "REDUCE", reason: stale ? `referee age_s ${age}` : "reference estimated (referee post not yet published)" };
  return { decision: "TRADE", reason: "fresh referee data" };
}
