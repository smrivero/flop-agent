/**
 * Agent B's TCLK verifier worker (`npm run technocore:tclk-verifier`). One-shot,
 * cron-friendly: read the room, accept any valid new offer from the trusted
 * payer, and advance every contract already accepted -- but the actual
 * verification WORK only happens once the folded transcript shows `locked`,
 * never earlier:
 *
 *   offer -> accept -> wait for lock -> WORK -> publish result -> reveal
 *
 * never "accept -> reveal -> work later". The gate is structural: the
 * independent fetch + OpenAI call only run inside the `locked` branch below.
 *
 * SECURITY (room content is untrusted input):
 *  - An offer is only actioned if (a) it is a structurally valid tclk/1 frame
 *    (b) posted through the signed lane and locally re-verified (transcript.ts)
 *    (c) `from` equals `config.allowedPayerDid` exactly (d) `job.id` resolves
 *    to a finding that actually exists, with `status='published'`, in our own
 *    copy of Radar's database -- never trusting anything in the room to
 *    describe the job itself. The canonical_url fetched for verification is
 *    ALWAYS the one Radar already stored for that finding_id, never anything
 *    read from the room.
 *  - The preimage is minted at accept time, stored only in the restricted
 *    local secret store (secretStore.ts), and is never logged, never placed
 *    in any Technocore message, until the reveal frame itself.
 */

import { generateHashLock, makeAccept, PaperRail, type ContractState, type OfferFrame } from "@flop-labs/tclk";
import { getFindingByFindingId } from "../mentions/database.js";
import { extractContent } from "../mentions/content/extractContent.js";
import { fetchArticleClassified } from "../mentions/content/fetchArticle.js";
import { verifyAnalysis } from "../verifier/openai.js";
import type { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import type { TclkConfig } from "./config.js";
import {
  getContractByFindingId,
  listOpenContracts,
  recordAccepted,
  updateContractCache,
  type TclkDb,
} from "./database.js";
import { getPreimage, storePreimage, type SecretDb } from "./secretStore.js";
import { technocoreNoteStore } from "./noteStore.js";
import { buildRevealFrame, postFrame } from "./frames.js";
import {
  decodeVerifiedFrames,
  findOfferById,
  findVerificationMessage,
  foldContract,
  readVerifiedMessages,
  type VerifiedFrame,
  type VerifiedMessage,
} from "./transcript.js";

export type VerifierAction =
  | { kind: "none"; reason: string }
  | { kind: "accept" }
  | { kind: "work_and_reveal" };

export function planVerifierAction(state: ContractState, hasVerificationMessage: boolean): VerifierAction {
  switch (state.status) {
    case "accepted":
      return { kind: "none", reason: "waiting for the payer to lock" };
    case "locked":
      return { kind: "work_and_reveal" };
    case "claimed":
      return { kind: "none", reason: hasVerificationMessage ? "already revealed" : "claimed with no local record -- nothing left to do" };
    case "refunded":
    case "cancelled":
      return { kind: "none", reason: `terminal: ${state.status}` };
    case "proposed":
      return { kind: "none", reason: "not accepted yet" };
  }
}

/** A pending offer eligible for B to accept: valid frame, from the trusted
 * payer, and its job.id resolves to a real, published Radar finding we have
 * not already accepted (or offered on, which would never happen for B, but
 * "no row yet" is the actual test either way). */
function findAcceptableOffers(db: TclkDb, config: TclkConfig, frames: VerifiedFrame[]): OfferFrame[] {
  const out: OfferFrame[] = [];
  const seenOfferIds = new Set<string>();
  for (const { frame } of frames) {
    if (frame.type !== "offer") continue;
    if (frame.from !== config.allowedPayerDid) continue;
    if (frame.role !== "payer") continue;
    if (frame.job === undefined || frame.job.proto !== "flop-verify") continue;
    if (seenOfferIds.has(frame.id)) continue;
    seenOfferIds.add(frame.id);

    const findingId = frame.job.id;
    const finding = getFindingByFindingId(db, findingId);
    if (finding === undefined || finding.status !== "published") continue; // not a Radar finding we know about

    // The row for this finding already exists (Agent A's offer step created
    // it) -- only its accept side (tclk_contract_id) tells us whether WE have
    // already accepted it. Checking row-existence alone would never accept
    // anything, since Agent A's offer always creates the row first.
    const existing = getContractByFindingId(db, findingId);
    if (existing !== undefined && existing.tclk_contract_id !== null) continue; // already accepted

    out.push(frame);
  }
  return out;
}

export interface VerifierContractReport {
  findingId: string;
  contractId?: string;
  status: string;
  action: VerifierAction;
  posted?: { kind: string; messageId: number };
  /** Set when accepting or advancing this contract threw (e.g. a network
   * timeout) -- the run continues to the next contract rather than aborting
   * the whole batch; a later cron tick retries. */
  error?: string;
}

export interface VerifierRunSummary {
  contracts: VerifierContractReport[];
  acceptedCount: number;
}

export interface RunTclkVerifierOptions {
  db: TclkDb;
  secretDb: SecretDb;
  client: TechnocoreClient;
  config: TclkConfig;
  identity: TechnocoreIdentity;
  openAiApiKey: string;
  verifierModel: string;
  dryRun: boolean;
  log: (event: string, fields: Record<string, unknown>) => void;
  rail?: PaperRail;
  readMessages?: () => Promise<VerifiedMessage[]>;
  /** Injectable for tests -- default to the real independent fetch. */
  fetchArticleFn?: typeof fetchArticleClassified;
  /** Injectable for tests -- default to the real OpenAI call. */
  analyzeFn?: typeof verifyAnalysis;
}

export function formatTclkVerificationMessage(fields: {
  findingId: string;
  contractId: string;
  result: "VERIFIED" | "REJECTED";
  reason: string;
  sourceUrl: string;
}): string {
  return [
    "Technocore Verification",
    "",
    `Finding: ${fields.findingId}`,
    `Contract: ${fields.contractId}`,
    "",
    `Result: ${fields.result}`,
    "",
    fields.reason,
    "",
    "Source:",
    fields.sourceUrl,
  ].join("\n");
}

export async function runTclkVerifier(options: RunTclkVerifierOptions): Promise<VerifierRunSummary> {
  const { db, secretDb, client, config, identity, dryRun, log } = options;
  const rail = options.rail ?? new PaperRail(technocoreNoteStore(client));
  const readMessages = options.readMessages ?? (() => readVerifiedMessages(client, config.room));
  const fetchArticleFn = options.fetchArticleFn ?? fetchArticleClassified;
  const analyzeFn = options.analyzeFn ?? verifyAnalysis;

  const messages = await readMessages();
  const frames = decodeVerifiedFrames(messages);
  const report: VerifierContractReport[] = [];
  let acceptedCount = 0;

  // Phase 1: accept any new, valid offer from the trusted payer. Isolated per
  // offer -- same discipline as mentions/run.ts and verifier/run.ts's own
  // per-item loops: one offer's network failure must not stop the others in
  // this same batch from being accepted.
  for (const offer of findAcceptableOffers(db, config, frames)) {
    const findingId = offer.job!.id;
    if (dryRun) {
      report.push({ findingId, status: "proposed", action: { kind: "accept" } });
      continue;
    }
    try {
      const lock = generateHashLock();
      const accept = makeAccept(offer, { from: identity.did, statement: lock.hash });
      // Persist the preimage BEFORE the accept is ever posted -- once the
      // accept (and its statement) is public, the secret must already be
      // safe on disk; posting first and storing after would risk minting a
      // statement nothing can ever open if the process died in between.
      storePreimage(secretDb, accept.contract, lock.preimage);
      const posted = await postFrame(client, config.room, accept, identity);
      recordAccepted(db, { findingId, contractId: accept.contract, offerId: offer.id, acceptMessageId: String(posted.seq) });
      // Fold this accept into the in-memory transcript immediately -- `frames`
      // was read once, before this loop started, so without this Phase 2 below
      // would re-derive state for this SAME contract against a snapshot that
      // predates the accept it just posted, and wrongly report it as still
      // "proposed". Appending at the end keeps `frames` seq-ordered, since
      // `posted.seq` is necessarily the highest seq seen so far.
      frames.push({ seq: posted.seq, from: identity.did, frame: accept });
      acceptedCount++;
      log("accept", { finding: findingId, contract: accept.contract, message_id: posted.seq });
      report.push({ findingId, contractId: accept.contract, status: "accepted", action: { kind: "accept" }, posted: { kind: "accept", messageId: posted.seq } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("action_failed", { finding: findingId, action: "accept", error: message });
      report.push({ findingId, status: "proposed", action: { kind: "accept" }, error: message });
    }
  }

  // Phase 2: advance every contract we've already accepted.
  for (const row of listOpenContracts(db)) {
    if (row.tclk_contract_id === null) continue; // not accepted yet -- phase 1's job, not phase 2's
    if (row.tclk_offer_id === null) continue;
    const offer = findOfferById(frames, row.tclk_offer_id);
    if (offer === undefined) {
      report.push({ findingId: row.finding_id, status: "accepted", action: { kind: "none", reason: "offer not found in transcript (unexpected)" } });
      continue;
    }
    const folded = foldContract(offer, frames);
    const { state } = folded;
    const contractId = state.contract;

    const hasVerificationMessage =
      contractId !== undefined ? findVerificationMessage(messages, row.finding_id, contractId, identity.did) !== undefined : false;
    const action = planVerifierAction(state, hasVerificationMessage);
    const entry: VerifierContractReport = { findingId: row.finding_id, contractId, status: state.status, action };
    report.push(entry);
    log("plan", { finding: row.finding_id, contract: contractId, status: state.status, action: action.kind, reason: "reason" in action ? action.reason : undefined });

    if (!dryRun && contractId !== undefined) {
      updateContractCache(db, row.finding_id, { tclkContractId: contractId, cachedStatus: state.status });
    }

    if (dryRun || action.kind !== "work_and_reveal" || contractId === undefined) continue;

    try {
      entry.posted = await workAndReveal({
        db,
        secretDb,
        client,
        config,
        identity,
        rail,
        row,
        state,
        contractId,
        messages,
        openAiApiKey: options.openAiApiKey,
        verifierModel: options.verifierModel,
        fetchArticleFn,
        analyzeFn,
        log,
      });
    } catch (err) {
      // Isolated per contract -- one contract's failure (network timeout on
      // the independent fetch, OpenAI error, publish failure) must not stop
      // phase 2 from checking every other open contract this run.
      const message = err instanceof Error ? err.message : String(err);
      entry.error = message;
      log("action_failed", { finding: row.finding_id, contract: contractId, action: "work_and_reveal", error: message });
    }
  }

  return { contracts: report, acceptedCount };
}

async function workAndReveal(ctx: {
  db: TclkDb;
  secretDb: SecretDb;
  client: TechnocoreClient;
  config: TclkConfig;
  identity: TechnocoreIdentity;
  rail: PaperRail;
  row: { finding_id: string };
  state: ContractState;
  contractId: string;
  messages: VerifiedMessage[];
  openAiApiKey: string;
  verifierModel: string;
  fetchArticleFn: typeof fetchArticleClassified;
  analyzeFn: typeof verifyAnalysis;
  log: (event: string, fields: Record<string, unknown>) => void;
}): Promise<{ kind: string; messageId: number } | undefined> {
  const { db, secretDb, client, config, identity, rail, row, state, contractId, messages, log } = ctx;

  const finding = getFindingByFindingId(db, row.finding_id);
  if (finding === undefined) {
    log("work_and_reveal", { finding: row.finding_id, contract: contractId, error: "finding no longer in local database" });
    return undefined;
  }

  // Already published a result but crashed before reveal -- do not re-spend
  // OpenAI or re-fetch; just re-derive the verdict from the existing message
  // and go straight to reveal.
  const existing = findVerificationMessage(messages, row.finding_id, contractId, identity.did);
  let result: "VERIFIED" | "REJECTED";

  if (existing !== undefined) {
    const match = /Result: (VERIFIED|REJECTED)/.exec(existing.text);
    result = (match?.[1] as "VERIFIED" | "REJECTED") ?? "REJECTED";
    log("work_and_reveal", { finding: row.finding_id, contract: contractId, reused_result: result });
  } else {
    const fetchResult = await ctx.fetchArticleFn(finding.canonical_url, { timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries });
    const sourceContent =
      fetchResult.kind === "ok"
        ? extractContent(fetchResult.html, 12000)
        : `(independent fetch failed: ${fetchResult.kind === "blocked" ? `blocked, HTTP ${fetchResult.status}` : "error"})`;

    const analysis = await ctx.analyzeFn(
      { originalFinding: finding.finding ?? "", sourceContent },
      { apiKey: ctx.openAiApiKey, model: ctx.verifierModel, timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries },
    );
    // verifyAnalysis's own response schema only ever produces VERIFIED|REJECTED
    // (UNVERIFIABLE is exclusive to the fetch-blocked path in verifier/run.ts,
    // which this worker doesn't go through) -- narrow explicitly rather than cast.
    if (analysis.result !== "VERIFIED" && analysis.result !== "REJECTED") {
      throw new Error(`tclk verifier: unexpected analysis result ${JSON.stringify(analysis.result)}`);
    }
    result = analysis.result;

    const text = formatTclkVerificationMessage({
      findingId: row.finding_id,
      contractId,
      result,
      reason: analysis.reason,
      sourceUrl: finding.canonical_url,
    });

    let postedSeq: number;
    try {
      const { posted } = await client.sendSignedMessage(config.room, text, { identity });
      postedSeq = posted.seq;
    } catch (err) {
      // MANDATORY: never reveal if publishing the result failed.
      const message = err instanceof Error ? err.message : String(err);
      log("work_and_reveal", { finding: row.finding_id, contract: contractId, error: `publish failed, refusing to reveal: ${message}` });
      return undefined;
    }
    updateContractCache(db, row.finding_id, { verificationMessageId: String(postedSeq) });
    log("verification", { finding: row.finding_id, contract: contractId, result, message_id: postedSeq });
  }

  const preimage = getPreimage(secretDb, contractId);
  if (preimage === undefined) {
    log("work_and_reveal", { finding: row.finding_id, contract: contractId, error: "no locally-stored preimage -- cannot reveal" });
    return undefined;
  }

  const revealFrame = buildRevealFrame({ from: identity.did, contract: contractId, secret: preimage });
  const posted = await postFrame(client, config.room, revealFrame, identity);
  await rail.claim(state.railRef ?? contractId, preimage);
  updateContractCache(db, row.finding_id, { cachedStatus: "claimed", revealMessageId: String(posted.seq) });
  log("reveal", { finding: row.finding_id, contract: contractId, message_id: posted.seq });
  return { kind: "reveal", messageId: posted.seq };
}
