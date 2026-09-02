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
import type { TclkMarketLogger } from "./logger.js";

export interface VerifiedFrameMessage {
  seq: number;
  from: string;
  frame: TclkFrame;
  raw: Message;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof TechnocoreError) return err.status !== undefined && err.status >= 500;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
): Promise<{ frames: VerifiedFrameMessage[]; lastSeq: number }> {
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
      return { frames, lastSeq: Math.max(view.last_seq, sinceSeq) };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt >= options.maxRetries) throw err;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw lastError; // unreachable in practice
}

/** Log-only helper: describe what a scan pass found, for [TCLK][SCANNER]. */
export function logScanResult(log: TclkMarketLogger, room: string, sinceSeq: number, result: { frames: VerifiedFrameMessage[]; lastSeq: number }): void {
  log.info("[SCANNER]", { room, since: sinceSeq, last_seq: result.lastSeq, frames_found: result.frames.length });
}
