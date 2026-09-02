/**
 * Agent A's TCLK payer worker (`npm run technocore:tclk-payer`). One-shot,
 * cron-friendly: read the room, reconstruct every open contract via
 * `applyFrame`, act on whichever transition is currently valid, exit.
 *
 * Authority for "what state is this contract in" is ALWAYS the folded
 * transcript (transcript.ts), never `tclk_contracts.cached_status` -- that
 * column is written back after every run purely so a human/test can inspect
 * it without replaying frames, and so listOpenContracts can skip terminal
 * rows cheaply. Every actual decision below reads `state.status` from the
 * fresh fold.
 */

import { lockTerms, PaperRail, type ContractState, type OfferFrame } from "@flop-labs/tclk";
import type { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import type { TclkConfig } from "./config.js";
import {
  listOpenContracts,
  updateContractCache,
  type TclkContractRow,
  type TclkDb,
} from "./database.js";
import { technocoreNoteStore } from "./noteStore.js";
import { buildLockFrame, buildReceiptFrame, buildRefundFrame, postFrame } from "./frames.js";
import {
  decodeVerifiedFrames,
  findOfferById,
  findVerificationMessage,
  foldContract,
  readVerifiedMessages,
  type VerifiedMessage,
} from "./transcript.js";

export type PayerAction =
  | { kind: "none"; reason: string }
  | { kind: "lock" }
  | { kind: "refund" }
  | { kind: "receipt" };

/** Pure decision function -- no I/O, fully unit-testable. Mirrors the state
 * machine's own guards (accepted->lock, locked+refund-window->refund,
 * claimed+verification-message->receipt) rather than inventing new rules. */
export function planPayerAction(state: ContractState, nowMs: number, hasVerificationMessage: boolean): PayerAction {
  switch (state.status) {
    case "proposed":
      return { kind: "none", reason: "waiting for accept" };
    case "accepted":
      return { kind: "lock" };
    case "locked":
      if (nowMs >= state.offer.refundAfterMs) return { kind: "refund" };
      return { kind: "none", reason: "locked, waiting for reveal (before refund window)" };
    case "claimed":
      if (!hasVerificationMessage) return { kind: "none", reason: "reveal seen but no verification message from the payee yet" };
      return { kind: "receipt" };
    case "refunded":
    case "cancelled":
      return { kind: "none", reason: `terminal: ${state.status}` };
  }
}

export interface PayerContractReport {
  findingId: string;
  contractId?: string;
  status: string;
  action: PayerAction;
  posted?: { kind: string; messageId: number };
}

export interface PayerRunSummary {
  contracts: PayerContractReport[];
}

export interface RunTclkPayerOptions {
  db: TclkDb;
  client: TechnocoreClient;
  config: TclkConfig;
  identity: TechnocoreIdentity;
  dryRun: boolean;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Injectable for tests -- defaults to a PaperRail over the real TechnocoreClient. */
  rail?: PaperRail;
  /** Injectable for tests -- defaults to reading the real room. */
  readMessages?: () => Promise<VerifiedMessage[]>;
  /** Injectable for tests -- defaults to Date.now. Lets a refund-after-timeout
   * scenario be tested without a real sleep. */
  now?: () => number;
}

export async function runTclkPayer(options: RunTclkPayerOptions): Promise<PayerRunSummary> {
  const { db, client, config, identity, dryRun, log } = options;
  const now = options.now ?? Date.now;
  const rail = options.rail ?? new PaperRail(technocoreNoteStore(client), now);
  const readMessages = options.readMessages ?? (() => readVerifiedMessages(client, config.room));

  const messages = await readMessages();
  const frames = decodeVerifiedFrames(messages);
  const rows = listOpenContracts(db);

  const report: PayerContractReport[] = [];

  for (const row of rows) {
    const offer = row.tclk_offer_id !== null ? findOfferById(frames, row.tclk_offer_id) : undefined;
    if (offer === undefined) {
      report.push({ findingId: row.finding_id, status: "proposed", action: { kind: "none", reason: "offer not found in transcript yet" } });
      continue;
    }

    const folded = foldContract(offer, frames);
    const { state } = folded;
    const contractId = state.contract;

    const hasVerificationMessage =
      state.status === "claimed" && contractId !== undefined && state.payeeDid !== undefined
        ? findVerificationMessage(messages, row.finding_id, contractId, state.payeeDid) !== undefined
        : false;

    const action = planPayerAction(state, now(), hasVerificationMessage);
    const entry: PayerContractReport = { findingId: row.finding_id, contractId, status: state.status, action };
    report.push(entry);

    // Keep the cache in sync with the transcript-derived truth even when no
    // action is taken this run -- purely for --dry-run / inspection accuracy,
    // never consulted as an authority (see file header).
    if (!dryRun && contractId !== undefined) {
      updateContractCache(db, row.finding_id, { tclkContractId: contractId, cachedStatus: state.status });
    }

    log("plan", { finding: row.finding_id, contract: contractId, status: state.status, action: action.kind, reason: "reason" in action ? action.reason : undefined });

    if (dryRun || action.kind === "none") continue;
    if (contractId === undefined) continue; // "none" already covers proposed; guard for the type-checker

    entry.posted = await executePayerAction(action.kind, {
      db,
      client,
      config,
      identity,
      rail,
      row,
      offer,
      state,
      contractId,
      messages,
      log,
    });
  }

  return { contracts: report };
}

async function executePayerAction(
  kind: "lock" | "refund" | "receipt",
  ctx: {
    db: TclkDb;
    client: TechnocoreClient;
    config: TclkConfig;
    identity: TechnocoreIdentity;
    rail: PaperRail;
    row: TclkContractRow;
    offer: OfferFrame;
    state: ContractState;
    contractId: string;
    messages: VerifiedMessage[];
    log: (event: string, fields: Record<string, unknown>) => void;
  },
): Promise<{ kind: string; messageId: number } | undefined> {
  const { db, client, config, identity, rail, row, state, contractId, log } = ctx;

  if (kind === "lock") {
    const terms = lockTerms(state);
    try {
      await rail.lock(terms);
    } catch (err) {
      // Idempotent retry: our own earlier attempt may have written the paper
      // note but failed to post the LOCK frame afterward. PaperRail's own ref
      // is always the contract id (paper-rail.ts), so this is safe to treat
      // as "already locked, just post the announcement" rather than a real error.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already has a record")) throw err;
    }
    const frame = buildLockFrame({ from: identity.did, contract: contractId, rail: config.rail, ref: contractId });
    const posted = await postFrame(client, config.room, frame, identity);
    updateContractCache(db, row.finding_id, { tclkContractId: contractId, cachedStatus: "locked", lockMessageId: String(posted.seq) });
    log("lock", { finding: row.finding_id, contract: contractId, message_id: posted.seq });
    return { kind: "lock", messageId: posted.seq };
  }

  if (kind === "refund") {
    const terms = lockTerms(state);
    await rail.refund(state.railRef ?? contractId);
    const frame = buildRefundFrame({ from: identity.did, contract: contractId, reason: `no reveal before refundAfterMs (${terms.refundAfterMs})` });
    const posted = await postFrame(client, config.room, frame, identity);
    updateContractCache(db, row.finding_id, { cachedStatus: "refunded" });
    log("refund", { finding: row.finding_id, contract: contractId, message_id: posted.seq });
    return { kind: "refund", messageId: posted.seq };
  }

  // receipt
  const frame = buildReceiptFrame({ from: identity.did, contract: contractId, outcome: "claimed", rail: config.rail, ref: state.railRef ?? contractId });
  const posted = await postFrame(client, config.room, frame, identity);
  // "receipted" (not "claimed") is what finally excludes this row from
  // listOpenContracts -- see its doc comment: a claimed contract still needs
  // this very step, so reusing tclk's own terminal status here would make the
  // row vanish from view one run too early.
  updateContractCache(db, row.finding_id, { cachedStatus: "receipted", receiptMessageId: String(posted.seq) });
  log("receipt", { finding: row.finding_id, contract: contractId, message_id: posted.seq });
  return { kind: "receipt", messageId: posted.seq };
}
