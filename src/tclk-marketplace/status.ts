/**
 * Health/status snapshot for the TCLK Marketplace Worker (`npm run tclk:status`
 * and a summary line logged at the end of every worker tick). Pure read of
 * local SQLite state plus the config/identity already loaded by the caller --
 * no network calls, so it's safe to run at any time, including while the
 * worker itself is mid-poll (WAL mode allows a concurrent reader).
 */

import type { TechnocoreIdentity } from "../identity.js";
import type { TclkMarketConfig } from "./config.js";
import { getErrorCount, getRoomCursor, type TclkMarketDb } from "./database.js";

export interface TclkMarketStatus {
  enabled: boolean;
  dryRun: boolean;
  did: string;
  offerRoom: string;
  lastOfferSeq: number;
  offersSeen: number;
  offersAccepted: number;
  offersRejected: number;
  offersIgnored: number;
  activeDeals: number;
  claimedDeals: number;
  refundedDeals: number;
  cancelledDeals: number;
  publishedOffers: number;
  openPublishedOffers: number;
  errors: number;
}

export function computeStatus(db: TclkMarketDb, config: TclkMarketConfig, identity: TechnocoreIdentity): TclkMarketStatus {
  const decisionCounts = db.prepare(`SELECT decision, COUNT(*) AS n FROM tclk_market_offer_decisions GROUP BY decision`).all() as {
    decision: string;
    n: number;
  }[];
  const byDecision = Object.fromEntries(decisionCounts.map((r) => [r.decision, r.n]));

  const statusCounts = db.prepare(`SELECT cached_status, COUNT(*) AS n FROM tclk_market_contracts GROUP BY cached_status`).all() as {
    cached_status: string;
    n: number;
  }[];
  const byStatus = Object.fromEntries(statusCounts.map((r) => [r.cached_status, r.n]));
  const activeDeals = (byStatus["accepted"] ?? 0) + (byStatus["locked"] ?? 0);
  const claimedDeals = (byStatus["claimed"] ?? 0) + (byStatus["claimed_receipted"] ?? 0);
  const refundedDeals = (byStatus["refunded"] ?? 0) + (byStatus["refunded_receipted"] ?? 0);
  const cancelledDeals = (byStatus["cancelled"] ?? 0) + (byStatus["cancelled_receipted"] ?? 0);

  const publishedTotals = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count FROM tclk_market_published_offers`).get() as {
    total: number;
    open_count: number | null;
  };

  return {
    enabled: config.enabled,
    dryRun: config.dryRun,
    did: identity.did,
    offerRoom: config.offerRoom,
    lastOfferSeq: getRoomCursor(db, config.offerRoom),
    offersSeen: decisionCounts.reduce((sum, r) => sum + r.n, 0),
    offersAccepted: byDecision["ACCEPT"] ?? 0,
    offersRejected: byDecision["REJECT"] ?? 0,
    offersIgnored: byDecision["IGNORE"] ?? 0,
    activeDeals,
    claimedDeals,
    refundedDeals,
    cancelledDeals,
    publishedOffers: publishedTotals.total,
    openPublishedOffers: publishedTotals.open_count ?? 0,
    errors: getErrorCount(db),
  };
}

export function formatStatus(status: TclkMarketStatus): string {
  return [
    "TCLK MARKET STATUS",
    `enabled: ${status.enabled}`,
    `dry_run: ${status.dryRun}`,
    `did: ${status.did}`,
    `offer_room: ${status.offerRoom}`,
    `lastSeq: ${status.lastOfferSeq}`,
    `offersSeen: ${status.offersSeen}`,
    `accepted: ${status.offersAccepted}`,
    `rejected: ${status.offersRejected}`,
    `ignored: ${status.offersIgnored}`,
    `activeDeals: ${status.activeDeals}`,
    `claimed: ${status.claimedDeals}`,
    `refunded: ${status.refundedDeals}`,
    `cancelled: ${status.cancelledDeals}`,
    `publishedOffers: ${status.publishedOffers} (${status.openPublishedOffers} open)`,
    `errors: ${status.errors}`,
  ].join("\n");
}
