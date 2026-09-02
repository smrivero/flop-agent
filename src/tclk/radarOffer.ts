/**
 * Agent A's (Radar's) one new step: after a finding is signed and published,
 * open a TCLK offer for it. Called from mentions/run.ts right after
 * markPublished succeeds -- wrapped in try/catch there, same discipline as
 * publishRadarState/maybePublishDailyStatus, so a TCLK failure never turns a
 * successfully-published finding into a reported failure.
 *
 * Idempotent by construction: `tclk_contracts` has a UNIQUE(finding_id), so a
 * finding gets exactly one offer, ever -- a retry of this function for the
 * same finding_id is a no-op once the row exists, never a second offer.
 *
 * No recipient field exists on an `offer` frame (tclk/1 offers are public by
 * design -- see SPEC.md §2/§3.1), so "directed at Agent B" is enforced on
 * Agent B's side (TCLK_ALLOWED_PAYER_DID + job.id resolving to a real
 * finding), not by anything in the frame itself. `job.id` carries finding_id
 * so a reader can tie contract back to finding without any invented field.
 */

import { makeOffer, type OfferFrame } from "@flop-labs/tclk";
import type { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import type { TclkConfig } from "./config.js";
import { getContractByFindingId, insertOfferedContract, type TclkDb } from "./database.js";
import { postFrame } from "./frames.js";

export interface RadarFindingForOffer {
  findingId: string;
}

export interface OfferOutcome {
  skipped: boolean;
  offer?: OfferFrame;
  messageId?: number;
}

export async function ensureTclkOffer(
  db: TclkDb,
  client: TechnocoreClient,
  config: TclkConfig,
  identity: TechnocoreIdentity,
  finding: RadarFindingForOffer,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<OfferOutcome> {
  if (getContractByFindingId(db, finding.findingId) !== undefined) {
    return { skipped: true }; // already offered -- one contract per finding, forever
  }

  const now = Date.now();
  const offer = makeOffer({
    from: identity.did,
    role: "payer",
    lock: "hash",
    amount: config.amount,
    asset: config.asset,
    rails: [config.rail],
    claimByMs: now + config.claimMinutes * 60_000,
    refundAfterMs: now + config.refundMinutes * 60_000,
    expiresMs: now + config.offerExpiresMinutes * 60_000,
    job: { proto: "flop-verify", id: finding.findingId },
  });

  const posted = await postFrame(client, config.room, offer, identity);
  insertOfferedContract(db, {
    findingId: finding.findingId,
    offerId: offer.id,
    offerMessageId: String(posted.seq),
  });
  log("tclk-offer", { finding: finding.findingId, offer_id: offer.id, message_id: posted.seq });
  return { skipped: false, offer, messageId: posted.seq };
}
