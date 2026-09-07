/**
 * Incremental, long-polling room reader for the TCLK Marketplace Worker.
 *
 * Deliberately NOT a reuse of src/tclk/transcript.ts's `readVerifiedMessages`:
 * that function always reads `since: 0` (by design -- the Radar<->Verifier flow
 * re-reads the whole room every run, see its own file header) which is exactly
 * the "tight polling / re-read the whole room" behavior this worker must avoid.
 * This module persists `lastSeq` per room (database.ts room_cursors) and always
 * reads `since=lastSeq`, using the venue's long-poll (`wait`, 0-10s) instead of
 * a tight loop -- see worker.ts for the outer backoff/sleep discipline.
 *
 * SECURITY: room content is untrusted input (see repo-level rule + AGENTS.md /
 * SECURITY.md of the tclk protocol). Every message is locally re-verified
 * (`verifyEd25519`) before anything downstream treats it as a commitment --
 * same choke point as transcript.ts's own doc comment explains. Non-tclk lines
 * (ordinary chat) and malformed tclk lines are silently ignored, never acted
 * on, never treated as instructions -- `tryDecodeFrame` is fail-closed.
 */

import { tryDecodeFrame, type TclkFrame } from "@flop-labs/tclk";
import { verifyEd25519 } from "../identity.js";
import { sweepText, TechnocoreError, type Message, type TechnocoreClient } from "../technocore.js";
import { incrementGapCounter, type TclkMarketDb } from "./database.js";
import type { TclkMarketLogger } from "./logger.js";

export interface VerifiedFrameMessage {
  seq: number;
  from: string;
  frame: TclkFrame;
  raw: Message;
}

function isRetryable(err: unknown): boolean {
  // 429 (rate limited) is deliberately retryable, same as a 5xx -- the server
  // is telling us to slow down, not that the request itself is wrong.
  // Regression: treating 429 as non-retryable meant every read behind a rate
  // limit failed on the very first attempt, permanently blocking that
  // contract's `planContractAction` (including the `cancel` fix for a stale
  // deal -- see dealManager.ts) from ever running that tick.
  if (err instanceof TechnocoreError) return err.status !== undefined && (err.status === 429 || err.status >= 500);
  return true;
}

/** `Retry-After` (seconds) when the server sent one (always true for a real
 * 429), else the same exponential schedule already used for 5xx. */
function backoffMs(err: unknown, attempt: number): number {
  if (err instanceof TechnocoreError && err.retryAfterSeconds !== undefined) {
    return err.retryAfterSeconds * 1000;
  }
  return 300 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ScanResult {
  frames: VerifiedFrameMessage[];
  lastSeq: number;
  /** Regression: the venue's own `RoomView.first_seq` doc comment says "if
   * it's > since+1 you missed lines (ring rotation)" -- this worker never
   * read that field at all, so a cursor that fell behind a high-traffic
   * room's ring buffer would silently lose frames with zero detection, zero
   * logging, zero metric. True when this read's own `first_seq` is further
   * ahead than `sinceSeq + 1`, meaning the ring rotated past messages this
   * cursor never saw. */
  gapDetected: boolean;
  /** Best-effort count of messages that fell in the gap (0 when no gap).
   * Not exact -- the ring's true content between `sinceSeq` and `first_seq`
   * is gone by definition -- but a useful order-of-magnitude signal. */
  missedEstimate: number;
}

/**
 * Read a room incrementally: `since=sinceSeq`, long-poll up to `waitSeconds`.
 * Returns only the NEW messages (seq > sinceSeq) that (a) carry a locally
 * re-verifiable signature and (b) decode as a structurally valid tclk/1 frame.
 * Plain chat and malformed/spoofed tclk lines are dropped here, never
 * surfaced -- exactly the "detect only tclk1..., ignore everything else"
 * requirement. `lastSeq` in the return value is the room's own `last_seq`,
 * for the caller to persist even when nothing new decoded (so a room full of
 * unrelated chat still advances the cursor and isn't re-scanned forever).
 */
export async function scanRoomForFrames(
  client: TechnocoreClient,
  room: string,
  sinceSeq: number,
  options: { waitSeconds: number; maxRetries: number },
): Promise<ScanResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const view = await client.readRoom(room, { since: sinceSeq, wait: options.waitSeconds });
      const frames: VerifiedFrameMessage[] = [];
      for (const message of view.messages) {
        if (message.seq <= sinceSeq) continue;
        if (message.sig === undefined || message.nonce === undefined) continue; // unsigned lane -- data, not a commitment
        const canonical = `${room}|${message.nonce}|${sweepText(message.text)}`;
        if (!verifyEd25519(message.from, message.sig, canonical)) continue; // spoofed/unsigned `from` -- dropped
        const frame = tryDecodeFrame(message.text); // fail-closed: null for non-tclk or malformed lines
        if (frame === null) continue;
        frames.push({ seq: message.seq, from: message.from, frame, raw: message });
      }
      // A brand-new room (first_seq null, nothing ever posted) is never a gap.
      const gapDetected = view.first_seq !== null && view.first_seq > sinceSeq + 1;
      const missedEstimate = gapDetected ? (view.first_seq as number) - (sinceSeq + 1) : 0;
      return { frames, lastSeq: Math.max(view.last_seq, sinceSeq), gapDetected, missedEstimate };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt >= options.maxRetries) throw err;
      await sleep(backoffMs(err, attempt));
    }
  }
  throw lastError; // unreachable in practice
}

/** Describes what a scan pass found, for [TCLK][SCANNER] -- and, whenever the
 * ring rotated past this cursor (see ScanResult's own doc comment), logs
 * [SCANNER][GAP] and persists it via incrementGapCounter so tclk:status can
 * report it. Every scanRoomForFrames call site should route its result
 * through this, so a gap is never silently dropped on the floor. */
export function logScanResult(db: TclkMarketDb, log: TclkMarketLogger, room: string, sinceSeq: number, result: ScanResult): void {
  log.info("[SCANNER]", { room, since: sinceSeq, last_seq: result.lastSeq, frames_found: result.frames.length });
  if (result.gapDetected) {
    log.info("[SCANNER][GAP]", { room, since: sinceSeq, missed_estimate: result.missedEstimate, note: "ring rotated past this cursor -- some frames were never seen" });
    incrementGapCounter(db, result.missedEstimate);
  }
}
