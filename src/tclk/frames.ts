/**
 * Frame builders tclk/1 v0.1.0 does NOT export (`makeLock`, `makeReveal`,
 * `makeRefund`, `makeReceipt` do not exist in this version -- only `makeOffer`
 * and `makeAccept` are provided, because only those two compute a derived id).
 * These mirror exactly the plain-object shape `examples/live-deal.mjs` builds
 * by hand (`{type:"lock", from, contract, rail, ref}` etc, per SPEC.md §3.3-3.5)
 * and are still real tclk/1 frames: every one of them goes through `encodeFrame`
 * (which runs `validateFrame` first) before it is ever posted, so a malformed
 * field is caught here, not on the wire.
 */

import { encodeFrame, type CancelFrame, type LockFrame, type ReceiptFrame, type RefundFrame, type RevealFrame } from "@flop-labs/tclk";
import type { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";

export function buildLockFrame(fields: { from: string; contract: string; rail: string; ref: string }): LockFrame {
  return { type: "lock", from: fields.from, contract: fields.contract, rail: fields.rail, ref: fields.ref };
}

export function buildRevealFrame(fields: { from: string; contract: string; secret: string }): RevealFrame {
  return { type: "reveal", from: fields.from, contract: fields.contract, secret: fields.secret };
}

export function buildRefundFrame(fields: { from: string; contract: string; reason?: string }): RefundFrame {
  return { type: "refund", from: fields.from, contract: fields.contract, reason: fields.reason };
}

export function buildCancelFrame(fields: { from: string; contract: string; reason?: string }): CancelFrame {
  return { type: "cancel", from: fields.from, contract: fields.contract, reason: fields.reason };
}

export function buildReceiptFrame(fields: {
  from: string;
  contract: string;
  outcome: "claimed" | "refunded" | "cancelled";
  rail?: string;
  ref?: string;
}): ReceiptFrame {
  return { type: "receipt", from: fields.from, contract: fields.contract, outcome: fields.outcome, rail: fields.rail, ref: fields.ref };
}

/** Post a tclk frame as one signed Technocore message. Thin wrapper --
 * `encodeFrame` does the actual protocol work (validate + canonical + ASCII +
 * length cap), `sendSignedMessage` does the actual signing + HTTP (identical
 * path Radar/Verifier already use for plain-text messages). */
export async function postFrame(
  client: TechnocoreClient,
  room: string,
  frame: Parameters<typeof encodeFrame>[0],
  identity: TechnocoreIdentity,
): Promise<{ seq: number }> {
  const line = encodeFrame(frame);
  const { posted } = await client.sendSignedMessage(room, line, { identity });
  return { seq: posted.seq };
}
