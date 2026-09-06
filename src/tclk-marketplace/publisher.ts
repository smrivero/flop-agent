/**
 * Offer Publisher: this worker acting as PAYER, offering its own job to the
 * public `tclk-offers` room. Two entry points:
 *  - `publishOffer` -- one offer, called from the CLI (`npm run tclk:offer`)
 *    or from `maybeAutoPublish` below.
 *  - `maybeAutoPublish` -- the `TCLK_MKT_AUTO_PUBLISH` policy: at most
 *    `TCLK_MKT_MAX_OPEN_OFFERS` open offers at a time, never more often than
 *    `TCLK_MKT_MIN_OFFER_INTERVAL_MS`, and never the identical offer twice
 *    (every offer carries a fresh random nonce -- `makeOffer` mints one -- so
 *    "the same offer" here means "another one on the same template while the
 *    rate limit hasn't cleared", which the interval check already prevents).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeOffer, type OfferFrame } from "@flop-labs/tclk";
import type { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import { postFrame } from "../tclk/frames.js";
import type { TclkMarketConfig } from "./config.js";
import { closeExpiredPublishedOffers, countOpenPublishedOffers, insertPublishedOffer, lastPublishedOfferAt, storeFrame, type TclkMarketDb } from "./database.js";
import type { TclkMarketLogger } from "./logger.js";

// One line at random becomes `job.context` for an offer that doesn't specify
// its own -- pure flavor text (the field is optional per tclk/1), meant to
// give a stranger reading the offer room something concrete to react to
// instead of a bare "echo" with a random id. Cached per path: the pool file
// doesn't change during a process's lifetime, and this runs once per offer.
// A missing/unreadable file just means no context, same as before this existed.
let cachedPool: { path: string; lines: string[] } | undefined;

function loadJobContextPool(path: string): string[] {
  if (cachedPool && cachedPool.path === path) return cachedPool.lines;
  let lines: string[] = [];
  try {
    lines = readFileSync(resolve(path), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    lines = [];
  }
  cachedPool = { path, lines };
  return lines;
}

function pickRandomJobContext(path: string): string | undefined {
  const lines = loadJobContextPool(path);
  return lines.length === 0 ? undefined : lines[Math.floor(Math.random() * lines.length)];
}

export interface PublishOfferOptions {
  amount?: string;
  asset?: string;
  jobType?: string;
  jobId?: string;
  jobContext?: string;
}

export function buildOwnOffer(config: TclkMarketConfig, identity: TechnocoreIdentity, options: PublishOfferOptions = {}): OfferFrame {
  const now = Date.now();
  return makeOffer({
    from: identity.did,
    role: "payer",
    lock: "hash",
    amount: options.amount ?? config.offerAmount,
    asset: options.asset ?? config.offerAsset,
    rails: [config.rail],
    claimByMs: now + config.claimMinutes * 60_000,
    refundAfterMs: now + config.refundMinutes * 60_000,
    expiresMs: now + config.offerExpiresMinutes * 60_000,
    job: {
      proto: options.jobType ?? config.offerJobType,
      id: options.jobId ?? `mkt-${now}-${Math.random().toString(16).slice(2, 8)}`,
      context: options.jobContext ?? pickRandomJobContext(config.offerJobContextPoolPath),
    },
  });
}

export async function publishOffer(
  db: TclkMarketDb,
  client: TechnocoreClient,
  config: TclkMarketConfig,
  identity: TechnocoreIdentity,
  identityOptions: PublishOfferOptions,
  log: TclkMarketLogger,
): Promise<{ offer: OfferFrame; messageId: number }> {
  const offer = buildOwnOffer(config, identity, identityOptions);
  log.info("[PUBLISHER][PUBLISHING]", { offer_id: offer.id, amount: offer.amount, asset: offer.asset, job: offer.job?.proto });
  const posted = await postFrame(client, config.offerRoom, offer, identity);
  insertPublishedOffer(db, {
    offerId: offer.id,
    jobProto: offer.job?.proto,
    jobId: offer.job?.id,
    amount: offer.amount,
    asset: offer.asset,
    rails: offer.rails,
    postedSeq: posted.seq,
  });
  // Cache the frame locally right away, rather than waiting for the next
  // scan tick to read it back -- lets an accept for this same offer be
  // recognized even within the same tick (worker.ts relies on the offer
  // frame already being in tclk_market_frames to verify an accept's contract id).
  storeFrame(db, {
    room: config.offerRoom,
    seq: posted.seq,
    from_did: identity.did,
    frame_type: "offer",
    contract_id: null,
    offer_id: offer.id,
    frame_json: JSON.stringify(offer),
    posted_at: new Date().toISOString(),
  });
  log.info("[PUBLISHER][POSTED]", { offer_id: offer.id, room: config.offerRoom, seq: posted.seq });
  return { offer, messageId: posted.seq };
}

export interface AutoPublishOutcome {
  published: boolean;
  reason: string;
  offerId?: string;
}

export async function maybeAutoPublish(
  db: TclkMarketDb,
  client: TechnocoreClient,
  config: TclkMarketConfig,
  identity: TechnocoreIdentity,
  log: TclkMarketLogger,
  now: () => number = Date.now,
): Promise<AutoPublishOutcome> {
  // Runs regardless of TCLK_MKT_AUTO_PUBLISH -- an offer past its own
  // expiresMs is un-acceptable to anyone and must stop counting against
  // TCLK_MKT_MAX_OPEN_OFFERS (and against tclk:status's "open" count) even on
  // a worker that only ever published offers by hand (`npm run tclk:offer`).
  const closed = closeExpiredPublishedOffers(db, now());
  if (closed > 0) log.info("[PUBLISHER][EXPIRED]", { closed });

  if (!config.autoPublish) return { published: false, reason: "auto_publish_disabled" };

  const openCount = countOpenPublishedOffers(db);
  if (openCount >= config.maxOpenOffers) {
    log.info("[PUBLISHER][SKIP]", { reason: "max_open_offers_reached", open: openCount, max: config.maxOpenOffers });
    return { published: false, reason: "max_open_offers_reached" };
  }

  const last = lastPublishedOfferAt(db);
  if (last !== undefined && now() - last < config.minOfferIntervalMs) {
    log.info("[PUBLISHER][SKIP]", { reason: "min_offer_interval_not_elapsed", since_last_ms: now() - last, min_ms: config.minOfferIntervalMs });
    return { published: false, reason: "min_offer_interval_not_elapsed" };
  }

  if (config.dryRun) {
    log.info("[PUBLISHER][DRY_RUN]", { reason: "would_publish", amount: config.offerAmount, asset: config.offerAsset, job: config.offerJobType });
    return { published: false, reason: "dry_run" };
  }

  const { offer } = await publishOffer(db, client, config, identity, {}, log);
  return { published: true, reason: "published", offerId: offer.id };
}
