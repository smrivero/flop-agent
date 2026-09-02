/**
 * Reads a Technocore room and folds it into TCLK contract state via tclk's own
 * `applyFrame` -- never a parallel, hand-rolled state machine. This is the
 * "Technocore transcript + tclk applyFrame is the authority" piece both
 * workers (payer.ts / verifierWorker.ts) build on.
 *
 * SECURITY: `applyFrame` (tclk/machine.ts) only checks that a frame's `from`
 * looks like a DID -- it does NOT check that the message was actually signed
 * by that DID. That check is the transport's job, and technocore's signed
 * lane already enforces it server-side, but a *reader* re-deriving state from
 * `readRoom()` JSON has no such guarantee for free: the JSON exposes `sig`/
 * `nonce` precisely so a reader can redo that check locally. Room content is
 * untrusted input (someone could post a plain unsigned `tclk1 {...}` line with
 * a spoofed `from`), so every frame here is re-verified locally
 * (`verifyEd25519`) before it is ever handed to `applyFrame`. This is the
 * single choke point that makes every other module in tclk/ safe to feed with
 * "whatever the room contains."
 */

import { applyFrame, openContract, tryDecodeFrame, type ContractState, type OfferFrame, type TclkFrame } from "@flop-labs/tclk";
import { verifyEd25519 } from "../identity.js";
import { sweepText, TechnocoreError, type Message, type TechnocoreClient } from "../technocore.js";

/** A room message that has been locally re-verified against its own claimed
 * `from` -- the only kind of message this module (or anything downstream of
 * it) is willing to treat as a commitment rather than as anonymous text. */
export interface VerifiedMessage extends Message {
  verifiedFrom: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a network error (fetch throwing, e.g. a timeout abort) or a 5xx
 * response -- the same "worth retrying" classification `fetchWithRetry`
 * (mentions/http.ts) uses for reads. A 4xx means the request itself is wrong;
 * retrying it would just repeat the same failure. */
function isRetryable(err: unknown): boolean {
  if (err instanceof TechnocoreError) return err.status !== undefined && err.status >= 500;
  return true; // anything else (AbortError, TypeError, ...) is a network-level failure
}

/**
 * Read the whole room and keep only messages whose signature checks out
 * locally. Unsigned-lane messages (no `sig`) and anything that fails
 * `verifyEd25519` are dropped -- never trusted, never folded into any frame
 * or matched as a finding/verification message.
 *
 * A plain `GET` (unlike a signed write, which never retries -- see
 * publisher.ts -- because its URL embeds a nonce that would replay-reject on
 * a second attempt), so retrying here is safe and, in practice, necessary:
 * this call is the one thing both `technocore:tclk-payer` and
 * `technocore:tclk-verifier` cannot do anything at all without, so a single
 * transient timeout would otherwise fail the entire run before it even got
 * to look at a single contract.
 */
export async function readVerifiedMessages(client: TechnocoreClient, room: string, maxRetries = 0): Promise<VerifiedMessage[]> {
  let lastError: unknown;
  let view: Awaited<ReturnType<TechnocoreClient["readRoom"]>> | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      view = await client.readRoom(room, { since: 0 });
      break;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      await sleep(300 * 2 ** attempt); // 300ms, 600ms, 1200ms...
    }
  }
  if (view === undefined) throw lastError; // unreachable in practice -- keeps the type-checker happy

  const verified: VerifiedMessage[] = [];
  for (const message of view.messages) {
    if (message.sig === undefined || message.nonce === undefined) continue; // unsigned lane -- data, not a commitment
    const canonical = `${room}|${message.nonce}|${sweepText(message.text)}`;
    if (verifyEd25519(message.from, message.sig, canonical)) {
      verified.push({ ...message, verifiedFrom: message.from });
    }
  }
  return verified;
}

export interface VerifiedFrame {
  seq: number;
  from: string;
  frame: TclkFrame;
}

/** Decode every tclk/1 frame out of an already-signature-verified message
 * list, in room order (seq is monotonic, so this is chronological). Malformed
 * or non-tclk lines are silently skipped -- `tryDecodeFrame` is fail-closed by
 * design (hostile/garbled text must not break a polling loop). */
export function decodeVerifiedFrames(messages: VerifiedMessage[]): VerifiedFrame[] {
  const out: VerifiedFrame[] = [];
  for (const message of messages) {
    const frame = tryDecodeFrame(message.text);
    if (frame !== null) out.push({ seq: message.seq, from: message.verifiedFrom, frame });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export interface FoldedContract {
  offer: OfferFrame;
  state: ContractState;
  /** seq of the message that carried each frame type, first occurrence only
   * (a duplicate/replay is rejected by applyFrame and never overwrites this). */
  messageIds: {
    offer?: number;
    accept?: number;
    lock?: number;
    reveal?: number;
    refund?: number;
    cancel?: number;
    receipt?: number;
  };
}

/**
 * Fold every frame naming this contract (plus the offer that opened it) into
 * final state, via `openContract` + `applyFrame` only. `frames` may contain
 * frames for OTHER contracts and non-tclk noise -- everything not naming this
 * contract (by id, or being the opening offer) is ignored, exactly the "world-
 * writable room, fold what applies" posture the library is built for.
 */
export function foldContract(offer: OfferFrame, frames: VerifiedFrame[]): FoldedContract {
  let state = openContract(offer);
  const messageIds: FoldedContract["messageIds"] = {};
  let contractId: string | undefined;

  for (const { seq, frame } of frames) {
    if (frame.type === "offer") continue; // opening offer already folded via openContract
    if ("contract" in frame) {
      if (contractId !== undefined && frame.contract !== contractId) continue; // a different deal
    } else {
      continue;
    }
    const step = applyFrame(state, frame, Date.now());
    if (!step.ok) continue; // invalid/duplicate/out-of-turn -- ignored, not thrown
    state = step.state;
    if (contractId === undefined && state.contract !== undefined) contractId = state.contract;
    const key = frame.type as keyof FoldedContract["messageIds"];
    if (messageIds[key] === undefined) messageIds[key] = seq;
  }

  return { offer, state, messageIds };
}

/** Find the offer frame with this exact `offerId` among decoded frames. */
export function findOfferById(frames: VerifiedFrame[], offerId: string): OfferFrame | undefined {
  for (const { frame } of frames) {
    if (frame.type === "offer" && frame.id === offerId) return frame;
  }
  return undefined;
}

/** Find the accept frame that closed this offer (by `ref`), if any. */
export function findAcceptForOffer(frames: VerifiedFrame[], offerId: string) {
  for (const { frame } of frames) {
    if (frame.type === "accept" && frame.ref === offerId) return frame;
  }
  return undefined;
}

/**
 * Find the plain-text "Technocore Verifier" result message for this
 * finding/contract, signed by the expected payee DID. Used by Agent A before
 * issuing a receipt (never trusting the reveal alone as proof a result was
 * published) and by Agent B to avoid re-publishing a result it already posted.
 * Text matching, not a tclk frame -- the verification message is ordinary
 * signed prose sharing the room with the tclk frames, per the "legible
 * transcript" requirement.
 */
export function findVerificationMessage(
  messages: VerifiedMessage[],
  findingId: string,
  contractId: string,
  payeeDid: string,
): VerifiedMessage | undefined {
  return messages.find(
    (m) =>
      m.verifiedFrom === payeeDid &&
      m.text.startsWith("Technocore Verification") &&
      m.text.includes(`Finding: ${findingId}`) &&
      m.text.includes(`Contract: ${contractId}`),
  );
}
