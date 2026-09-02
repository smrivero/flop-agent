/**
 * Offer Policy Engine: `shouldAcceptOffer` decides, for one incoming `offer`
 * frame read from a public (untrusted) room, whether this worker will ACCEPT
 * it, REJECT it, or IGNORE it -- and always says why. No auto-accept without
 * every configured rule passing; see config.ts for the knobs
 * (`TCLK_MKT_AUTO_ACCEPT`, `TCLK_MKT_ALLOWED_RAILS`, etc).
 *
 * Pure and synchronous -- no I/O, no DB, so it's trivially unit-testable and
 * so worker.ts can log `[TCLK][POLICY][RESULT]` for every offer regardless of
 * whether it goes on to actually accept it.
 *
 * IGNORE vs REJECT: IGNORE means "not a candidate for evaluation at all"
 * (already decided before, or an offer shape we don't participate in as a
 * counterparty). REJECT means "evaluated against policy and a rule failed" --
 * both are terminal for this offer id (see database.ts offer_decisions), the
 * distinction is only for legibility in logs/status.
 */

import type { OfferFrame } from "@flop-labs/tclk";
import type { TclkMarketConfig } from "./config.js";

export type PolicyDecision = "ACCEPT" | "REJECT" | "IGNORE";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

export interface PolicyContext {
  now: number;
  /** Number of contracts where WE are payee and the deal is still open
   * (accepted or locked) -- what TCLK_MKT_MAX_CONCURRENT_DEALS bounds. */
  activePayeeDeals: number;
  /** True if this offer id has already been decided (dedupe / no reprocessing). */
  alreadyDecided: boolean;
}

function ok(): PolicyResult {
  return { decision: "ACCEPT", reason: "supported_offer" };
}
function reject(reason: string): PolicyResult {
  return { decision: "REJECT", reason };
}
function ignore(reason: string): PolicyResult {
  return { decision: "IGNORE", reason };
}

export function shouldAcceptOffer(offer: OfferFrame, config: TclkMarketConfig, ctx: PolicyContext): PolicyResult {
  if (ctx.alreadyDecided) return ignore("already_processed");

  // This worker only auto-accepts offers where the counterparty is the PAYER
  // (we do the work / hold the secret, i.e. we'd become payee). An offer where
  // the sender is already asking to be the payee is a different negotiation
  // shape this first version does not automate -- see README limitations.
  if (offer.role !== "payer") return ignore("unsupported_role");

  if (!config.autoAccept) return reject("auto_accept_disabled");

  if (offer.job === undefined) return reject("missing_job");
  if (!config.supportedJobTypes.includes(offer.job.proto)) return reject("unsupported_job_type");

  if (config.allowedCounterpartyDids.length > 0 && !config.allowedCounterpartyDids.includes(offer.from)) {
    return reject("untrusted_counterparty");
  }

  if (offer.expiresMs <= ctx.now) return reject("offer_expired");
  if (offer.claimByMs <= ctx.now) return reject("claim_by_in_past");
  if (offer.refundAfterMs <= offer.claimByMs) return reject("invalid_deadlines"); // protocol invariant, defense in depth
  if (offer.claimByMs - ctx.now > config.maxJobDurationMs) return reject("job_duration_too_long");

  const supportedRail = offer.rails.some((r) => config.allowedRails.includes(r));
  if (!supportedRail) return reject("unsupported_rail");

  if (!config.allowedAssets.includes(offer.asset)) return reject("unsupported_asset");

  let amount: bigint;
  try {
    amount = BigInt(offer.amount);
  } catch {
    return reject("invalid_amount");
  }
  if (amount < 0n) return reject("invalid_amount");
  if (amount < config.minAmount) return reject("amount_below_minimum");

  if (offer.lock !== "hash") return reject("unsupported_lock_kind"); // this worker only mints hash-lock secrets (PaperRail path)

  if (ctx.activePayeeDeals >= config.maxConcurrentDeals) return reject("max_concurrent_deals_reached");

  return ok();
}
