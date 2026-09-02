/**
 * The TCLK Marketplace Worker's core tick: scan `tclk-offers` for new offers
 * and accepts of our own offers, advance every open contract's deal room, run
 * the offer policy, run the executor, publish our own offers. One call =
 * one full pass; worker-cli.ts wraps this in a long-poll loop with backoff.
 *
 * Every decision authority is the FOLDED TRANSCRIPT
 * (`@flop-labs/tclk`'s own `applyFrame`, via `foldContract`), never memory or
 * `cached_status` alone -- see database.ts's own doc comment. Local SQLite
 * (database.ts) is an incremental cache of frames actually read off the wire
 * (so a restart never re-reads a whole room) plus an idempotency index (so a
 * restart never re-accepts / re-locks / re-reveals / re-receipts).
 *
 * Per-item isolation: one offer's or one contract's failure is caught, logged
 * (`[TCLK][ERROR]`), and counted -- never aborts the rest of this tick. Same
 * discipline src/tclk/payer.ts and verifierWorker.ts already use.
 */

import {
  applyFrame,
  contractId as computeContractId,
  dealRoom,
  generateHashLock,
  lockTerms,
  makeAccept,
  openContract,
  PaperRail,
  type AcceptFrame,
  type ContractState,
  type OfferFrame,
  type TclkFrame,
} from "@flop-labs/tclk";
import type { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import { buildLockFrame, buildReceiptFrame, buildRefundFrame, buildRevealFrame, postFrame } from "../tclk/frames.js";
import { getPreimage, storePreimage, type SecretDb } from "../tclk/secretStore.js";
import { technocoreNoteStore } from "../tclk/noteStore.js";
import type { TclkMarketConfig } from "./config.js";
import {
  countActiveContractsByRole,
  getContract,
  getOfferDecision,
  getRoomCursor,
  incrementErrorCounter,
  insertContract,
  listOpenContracts,
  markPublishedOfferAccepted,
  offerFrameById,
  recordOfferDecision,
  setRoomCursor,
  storeFrame,
  updateContractCache,
  type TclkMarketDb,
  type TclkMarketContractRow,
} from "./database.js";
import { executeJob, UnsupportedJobError } from "./executor.js";
import { planContractAction } from "./dealManager.js";
import { fingerprintSecret, type TclkMarketLogger } from "./logger.js";
import { shouldAcceptOffer } from "./policy.js";
import { maybeAutoPublish } from "./publisher.js";
import { scanRoomForFrames, type VerifiedFrameMessage } from "./scanner.js";

export interface TclkMarketWorkerContext {
  db: TclkMarketDb;
  secretDb: SecretDb;
  client: TechnocoreClient;
  config: TclkMarketConfig;
  identity: TechnocoreIdentity;
  log: TclkMarketLogger;
  rail?: PaperRail;
  now?: () => number;
}

export interface TickSummary {
  offersFound: number;
  offersAccepted: number;
  offersRejected: number;
  offersIgnored: number;
  contractsAdvanced: number;
  errors: number;
  autoPublished: boolean;
}

type StoredFrameEntry = { seq: number; from: string; frame: TclkFrame };

function toFrameRow(room: string, m: VerifiedFrameMessage): Parameters<typeof storeFrame>[1] {
  const contractIdField = "contract" in m.frame ? (m.frame as { contract: string }).contract : null;
  const offerIdField = m.frame.type === "offer" ? m.frame.id : m.frame.type === "accept" ? m.frame.ref : null;
  return {
    room,
    seq: m.seq,
    from_did: m.from,
    frame_type: m.frame.type,
    contract_id: contractIdField,
    offer_id: offerIdField,
    frame_json: JSON.stringify(m.frame),
  };
}

function loadContractFrames(db: TclkMarketDb, offerId: string, contractId: string): { offer: OfferFrame; frames: StoredFrameEntry[] } {
  const offerRow = offerFrameById(db, offerId);
  if (offerRow === undefined) throw new Error(`internal: no locally-stored offer frame for offer_id=${offerId}`);
  const offer = JSON.parse(offerRow.frame_json) as OfferFrame;
  const rows = db.prepare(`SELECT * FROM tclk_market_frames WHERE contract_id = ? ORDER BY seq ASC`).all(contractId) as {
    seq: number;
    from_did: string;
    frame_json: string;
  }[];
  const frames: StoredFrameEntry[] = rows.map((r) => ({ seq: r.seq, from: r.from_did, frame: JSON.parse(r.frame_json) as TclkFrame }));
  return { offer, frames };
}

// `seq` is only monotonic WITHIN one room -- accept lives in the offers room,
// everything else in the per-contract deal room (SPEC.md "Where"), so those
// are two unrelated sequence spaces. Sorting frames by raw seq across rooms
// can put e.g. a deal-room lock (seq=1 in ITS room) before the offers-room
// accept (seq=2 in ITS room), which applyFrame then rejects as out-of-turn --
// silently stalling the fold. Sort by protocol stage instead (a frame type
// can only ever cause one specific transition -- SPEC.md §4), falling back to
// seq only to order same-stage frames within the one room they share.
const FRAME_STAGE: Record<TclkFrame["type"], number> = { offer: 0, accept: 1, lock: 2, reveal: 3, refund: 3, cancel: 3, receipt: 4 };

function foldFromStore(db: TclkMarketDb, offerId: string, contractId: string): ContractState {
  const { offer, frames } = loadContractFrames(db, offerId, contractId);
  let state = openContract(offer);
  const ordered = [...frames].sort((a, b) => FRAME_STAGE[a.frame.type] - FRAME_STAGE[b.frame.type] || a.seq - b.seq);
  for (const { frame } of ordered) {
    if (frame.type === "offer") continue;
    if (!("contract" in frame) || frame.contract !== contractId) continue;
    const step = applyFrame(state, frame, Date.now());
    if (step.ok) state = step.state;
  }
  return state;
}

// -- phase 1: scan tclk-offers ---------------------------------------------------

async function scanOffersRoom(ctx: TclkMarketWorkerContext, summary: TickSummary): Promise<void> {
  const { db, client, config, log } = ctx;
  const since = getRoomCursor(db, config.offerRoom);
  const result = await scanRoomForFrames(client, config.offerRoom, since, { waitSeconds: config.longPollWaitSeconds, maxRetries: config.maxRetries });
  log.info("[SCANNER]", { room: config.offerRoom, since, last_seq: result.lastSeq, frames_found: result.frames.length });

  for (const m of result.frames) {
    // Cache every verified frame we see in this room, regardless of type or
    // whether it's ours -- this is what lets a contract be re-folded locally
    // later without re-reading the room. Never store BEFORE this room read is
    // itself the authority for what's new (idempotent: (room,seq) is unique).
    storeFrame(db, toFrameRow(config.offerRoom, m));

    if (m.frame.type === "offer") {
      summary.offersFound++;
      await handleOfferFrame(ctx, m.frame, m.from, summary);
    } else if (m.frame.type === "accept") {
      await handleAcceptFrame(ctx, m.frame, m.from);
    }
    // Other frame types are never expected in tclk-offers per SPEC.md ("Where"),
    // but if a stray one appears it's just cached above and otherwise ignored --
    // never acted on outside its actual deal room.
  }

  if (!ctx.config.dryRun) setRoomCursor(db, config.offerRoom, result.lastSeq);
}

async function handleOfferFrame(ctx: TclkMarketWorkerContext, offer: OfferFrame, from: string, summary: TickSummary): Promise<void> {
  const { db, config, log } = ctx;
  const now = (ctx.now ?? Date.now)();

  if (offer.from !== from) {
    log.info("[OFFER][REJECTED]", { offer: offer.id, reason: "from_mismatch" }); // spoofed `from` field vs the transport-verified sender
    return;
  }

  // Our own offer, read back off the wire (every offer we publish gets
  // scanned again like any other room message) -- never a candidate to
  // accept against ourselves. Its lifecycle is driven entirely by
  // handleAcceptFrame (once a counterparty accepts it) instead.
  if (offer.from === ctx.identity.did) return;

  log.info("[OFFER][FOUND]", { room: config.offerRoom, contract: undefined, offer: offer.id, payer: offer.from, amount: offer.amount, asset: offer.asset, rails: offer.rails.join(",") });

  const alreadyDecided = getOfferDecision(db, offer.id) !== undefined;
  const activePayeeDeals = countActiveContractsByRole(db, "payee");
  const policy = shouldAcceptOffer(offer, config, { now, activePayeeDeals, alreadyDecided });
  log.info("[POLICY][RESULT]", { offer: offer.id, decision: policy.decision, reason: policy.reason });

  if (policy.decision !== "ACCEPT") {
    if (policy.decision === "REJECT") summary.offersRejected++;
    else summary.offersIgnored++;
    if (!alreadyDecided && !ctx.config.dryRun) {
      recordOfferDecision(db, { offerId: offer.id, fromDid: offer.from, decision: policy.decision, reason: policy.reason, amount: offer.amount, asset: offer.asset });
    }
    if (policy.decision === "REJECT") log.info("[OFFER][REJECTED]", { offer: offer.id, reason: policy.reason });
    return;
  }

  if (ctx.config.dryRun) {
    log.info("[OFFER][ACCEPTING]", { offer: offer.id, dry_run: true, would: "accept" });
    summary.offersAccepted++;
    return;
  }

  await acceptOffer(ctx, offer, summary);
}

async function acceptOffer(ctx: TclkMarketWorkerContext, offer: OfferFrame, summary: TickSummary): Promise<void> {
  const { db, secretDb, client, config, identity, log } = ctx;
  log.info("[OFFER][ACCEPTING]", { offer: offer.id, payer: offer.from });

  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: identity.did, statement: lock.hash });

  // MUST persist the preimage before the accept is ever posted -- once public,
  // the secret must already be safe on disk. Same discipline as
  // src/tclk/verifierWorker.ts.
  storePreimage(secretDb, accept.contract, lock.preimage);
  log.info("[ACCEPT][SECRET_STORED]", { contract: accept.contract, secretFingerprint: fingerprintSecret(lock.preimage) });

  let posted: { seq: number };
  try {
    posted = await postFrame(client, config.offerRoom, accept, identity);
  } catch (err) {
    log.info("[ERROR]", { stage: "accept_post", offer: offer.id, error: err instanceof Error ? err.message : String(err) });
    incrementErrorCounter(db);
    return;
  }

  storeFrame(db, { room: config.offerRoom, seq: posted.seq, from_did: identity.did, frame_type: "accept", contract_id: accept.contract, offer_id: accept.ref, frame_json: JSON.stringify(accept) });
  recordOfferDecision(db, { offerId: offer.id, fromDid: offer.from, decision: "ACCEPT", reason: "supported_offer", contractId: accept.contract, amount: offer.amount, asset: offer.asset });

  const room = dealRoom(accept.contract);
  insertContract(db, {
    contract_id: accept.contract,
    offer_id: offer.id,
    role: "payee",
    payer_did: offer.from,
    payee_did: identity.did,
    asset: offer.asset,
    amount: offer.amount,
    rail: null,
    job_proto: offer.job?.proto ?? null,
    job_id: offer.job?.id ?? null,
    deal_room: room,
    cached_status: "accepted",
    claim_by_ms: offer.claimByMs,
    refund_after_ms: offer.refundAfterMs,
    expires_ms: offer.expiresMs,
    secret_fingerprint: fingerprintSecret(lock.preimage),
  });

  log.info("[ACCEPT][POSTED]", { offer: offer.id, contract: accept.contract, room: config.offerRoom, seq: posted.seq, deal_room: room });
  summary.offersAccepted++;
}

async function handleAcceptFrame(ctx: TclkMarketWorkerContext, accept: AcceptFrame, from: string): Promise<void> {
  const { db, log } = ctx;
  if (accept.from !== from) return; // spoofed `from` -- dropped

  const existingContract = getContract(db, accept.contract);
  if (existingContract !== undefined) return; // already known (our own accept, or already recorded)

  const offerRow = offerFrameById(db, accept.ref);
  if (offerRow === undefined) return; // not one of our offers (or not seen yet) -- nothing to do here
  if (offerRow.from_did !== ctx.identity.did) return; // an accept for someone else's offer -- not ours to act on

  const offer = JSON.parse(offerRow.frame_json) as OfferFrame;
  const recomputed = computeContractId(offer, { from: accept.from, ref: accept.ref, statement: accept.statement, paymentKey: accept.paymentKey, nonce: accept.nonce });
  if (recomputed !== accept.contract) {
    log.info("[ERROR]", { stage: "accept_verify", offer: accept.ref, reason: "contract_id_mismatch", note: "possible spoofed accept -- ignored" });
    return;
  }

  const room = dealRoom(accept.contract);
  insertContract(db, {
    contract_id: accept.contract,
    offer_id: accept.ref,
    role: "payer",
    payer_did: offer.from,
    payee_did: accept.from,
    asset: offer.asset,
    amount: offer.amount,
    rail: null,
    job_proto: offer.job?.proto ?? null,
    job_id: offer.job?.id ?? null,
    deal_room: room,
    cached_status: "accepted",
    claim_by_ms: offer.claimByMs,
    refund_after_ms: offer.refundAfterMs,
    expires_ms: offer.expiresMs,
    secret_fingerprint: null,
  });
  markPublishedOfferAccepted(db, accept.ref, accept.contract);
  log.info("[DEAL][ACCEPTED_BY_COUNTERPARTY]", { offer: accept.ref, contract: accept.contract, payee: accept.from, deal_room: room });
}

// -- phase 2: advance every open contract's deal room ----------------------------

async function advanceContracts(ctx: TclkMarketWorkerContext, summary: TickSummary): Promise<void> {
  const { db, log } = ctx;
  for (const row of listOpenContracts(db)) {
    try {
      await advanceOneContract(ctx, row, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.info("[ERROR]", { stage: "advance_contract", contract: row.contract_id, error: message });
      incrementErrorCounter(db);
      summary.errors++;
    }
  }
}

async function advanceOneContract(ctx: TclkMarketWorkerContext, row: TclkMarketContractRow, summary: TickSummary): Promise<void> {
  const { db, client, config, log } = ctx;
  const now = (ctx.now ?? Date.now)();

  const since = getRoomCursor(db, row.deal_room);
  const result = await scanRoomForFrames(client, row.deal_room, since, { waitSeconds: 0, maxRetries: config.maxRetries });
  for (const m of result.frames) storeFrame(db, toFrameRow(row.deal_room, m));
  if (!ctx.config.dryRun) setRoomCursor(db, row.deal_room, result.lastSeq);

  const state = foldFromStore(db, row.offer_id, row.contract_id);
  if (state.status !== row.cached_status) {
    log.info("[STATE][TRANSITION]", { contract: row.contract_id, previous: row.cached_status, next: state.status });
    if (!ctx.config.dryRun) updateContractCache(db, row.contract_id, { cachedStatus: state.status });
  }
  summary.contractsAdvanced++;

  const action = planContractAction(state, row.role, now, row.receipted === 1);
  log.info("[DEAL][STATE]", { contract: row.contract_id, role: row.role, status: state.status, action: action.kind, reason: "reason" in action ? action.reason : undefined });

  if (ctx.config.dryRun) {
    if (action.kind !== "none") log.info("[DEAL][DRY_RUN]", { contract: row.contract_id, would: action.kind });
    return;
  }
  if (action.kind === "none") return;

  const rail = ctx.rail ?? new PaperRail(technocoreNoteStore(client));

  if (action.kind === "lock") {
    await doLock(ctx, row, state, rail, log);
  } else if (action.kind === "refund") {
    await doRefund(ctx, row, state, rail, log);
  } else if (action.kind === "work_and_reveal") {
    await doWorkAndReveal(ctx, row, state, rail, log);
  } else if (action.kind === "receipt") {
    await doReceipt(ctx, row, state, action.outcome, log);
  }
}

async function doLock(ctx: TclkMarketWorkerContext, row: TclkMarketContractRow, state: ContractState, rail: PaperRail, log: TclkMarketLogger): Promise<void> {
  const { db, client, config, identity } = ctx;
  const terms = lockTerms(state);
  try {
    await rail.lock(terms);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("already has a record")) throw err; // idempotent retry -- our own earlier attempt may have written the note but not posted the frame
  }
  const frame = buildLockFrame({ from: identity.did, contract: row.contract_id, rail: config.rail, ref: row.contract_id });
  const posted = await postFrame(client, row.deal_room, frame, identity);
  storeFrame(db, { room: row.deal_room, seq: posted.seq, from_did: identity.did, frame_type: "lock", contract_id: row.contract_id, offer_id: null, frame_json: JSON.stringify(frame) });
  updateContractCache(db, row.contract_id, { cachedStatus: "locked", rail: config.rail });
  log.info("[LOCK][POSTED]", { contract: row.contract_id, room: row.deal_room, seq: posted.seq });
}

async function doRefund(ctx: TclkMarketWorkerContext, row: TclkMarketContractRow, state: ContractState, rail: PaperRail, log: TclkMarketLogger): Promise<void> {
  const { db, client, config, identity } = ctx;
  await rail.refund(state.railRef ?? row.contract_id);
  const frame = buildRefundFrame({ from: identity.did, contract: row.contract_id, reason: `no reveal before refundAfterMs (${state.offer.refundAfterMs})` });
  const posted = await postFrame(client, row.deal_room, frame, identity);
  storeFrame(db, { room: row.deal_room, seq: posted.seq, from_did: identity.did, frame_type: "refund", contract_id: row.contract_id, offer_id: null, frame_json: JSON.stringify(frame) });
  updateContractCache(db, row.contract_id, { cachedStatus: "refunded" });
  log.info("[REFUND][POSTED]", { contract: row.contract_id, room: row.deal_room, seq: posted.seq });
}

async function doWorkAndReveal(ctx: TclkMarketWorkerContext, row: TclkMarketContractRow, state: ContractState, rail: PaperRail, log: TclkMarketLogger): Promise<void> {
  const { db, secretDb, client, config, identity } = ctx;
  log.info("[CLAIM][START]", { contract: row.contract_id, job: row.job_proto });

  const preimage = getPreimage(secretDb, row.contract_id);
  if (preimage === undefined) {
    log.info("[ERROR]", { stage: "work_and_reveal", contract: row.contract_id, error: "no locally-stored preimage -- cannot reveal" });
    incrementErrorCounter(db);
    return;
  }

  let result;
  try {
    result = executeJob({ proto: row.job_proto ?? "", id: row.job_id ?? row.contract_id, contractId: row.contract_id }, config.supportedJobTypes);
  } catch (err) {
    if (err instanceof UnsupportedJobError) {
      log.info("[EXECUTOR][REJECTED]", { contract: row.contract_id, job: row.job_proto, error: err.message });
      return; // never reveal for a job we won't run -- lets the refund window handle it
    }
    throw err;
  }
  log.info("[EXECUTOR][DONE]", { contract: row.contract_id, job: row.job_proto, ok: result.ok, summary: result.summary });

  const revealFrame = buildRevealFrame({ from: identity.did, contract: row.contract_id, secret: preimage });
  log.info("[CLAIM][REVEAL_CREATED]", { contract: row.contract_id, secretFingerprint: fingerprintSecret(preimage) });
  const posted = await postFrame(client, row.deal_room, revealFrame, identity);
  storeFrame(db, { room: row.deal_room, seq: posted.seq, from_did: identity.did, frame_type: "reveal", contract_id: row.contract_id, offer_id: null, frame_json: JSON.stringify(revealFrame) });
  log.info("[CLAIM][POSTED]", { contract: row.contract_id, room: row.deal_room, seq: posted.seq });

  await rail.claim(state.railRef ?? row.contract_id, preimage);

  // Do not trust the HTTP 200 alone -- re-read the deal room and re-fold to
  // confirm the transcript itself now produces `claimed` before declaring victory.
  const verify = await scanRoomForFrames(client, row.deal_room, getRoomCursor(db, row.deal_room), { waitSeconds: 0, maxRetries: config.maxRetries });
  for (const m of verify.frames) storeFrame(db, toFrameRow(row.deal_room, m));
  setRoomCursor(db, row.deal_room, verify.lastSeq);
  const reFolded = foldFromStore(db, row.offer_id, row.contract_id);
  if (reFolded.status === "claimed") {
    updateContractCache(db, row.contract_id, { cachedStatus: "claimed" });
    log.info("[CLAIM][VERIFIED]", { contract: row.contract_id, state: "claimed" });
  } else {
    log.info("[ERROR]", { stage: "claim_verify", contract: row.contract_id, expected: "claimed", actual: reFolded.status });
    incrementErrorCounter(db);
  }
}

async function doReceipt(
  ctx: TclkMarketWorkerContext,
  row: TclkMarketContractRow,
  state: ContractState,
  outcome: "claimed" | "refunded" | "cancelled",
  log: TclkMarketLogger,
): Promise<void> {
  const { db, client, config, identity } = ctx;
  const frame = buildReceiptFrame({ from: identity.did, contract: row.contract_id, outcome, rail: config.rail, ref: state.railRef ?? row.contract_id });
  log.info("[RECEIPT][CREATED]", { contract: row.contract_id, outcome });
  const posted = await postFrame(client, row.deal_room, frame, identity);
  storeFrame(db, { room: row.deal_room, seq: posted.seq, from_did: identity.did, frame_type: "receipt", contract_id: row.contract_id, offer_id: null, frame_json: JSON.stringify(frame) });
  updateContractCache(db, row.contract_id, { receipted: true, cachedStatus: `${outcome}_receipted` });
  log.info("[RECEIPT][POSTED]", { contract: row.contract_id, room: row.deal_room, seq: posted.seq });
}

// -- entry point -------------------------------------------------------------------

export async function runTclkMarketTick(ctx: TclkMarketWorkerContext): Promise<TickSummary> {
  const summary: TickSummary = { offersFound: 0, offersAccepted: 0, offersRejected: 0, offersIgnored: 0, contractsAdvanced: 0, errors: 0, autoPublished: false };

  try {
    await scanOffersRoom(ctx, summary);
  } catch (err) {
    ctx.log.info("[ERROR]", { stage: "scan_offers", error: err instanceof Error ? err.message : String(err) });
    incrementErrorCounter(ctx.db);
    summary.errors++;
  }

  await advanceContracts(ctx, summary);

  try {
    const outcome = await maybeAutoPublish(ctx.db, ctx.client, ctx.config, ctx.identity, ctx.log, ctx.now);
    summary.autoPublished = outcome.published;
  } catch (err) {
    ctx.log.info("[ERROR]", { stage: "auto_publish", error: err instanceof Error ? err.message : String(err) });
    incrementErrorCounter(ctx.db);
    summary.errors++;
  }

  return summary;
}
