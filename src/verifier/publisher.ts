/**
 * Publishing reuses TechnocoreClient.sendSignedMessage exactly as Radar's own
 * publisher does (mentions/publisher/publishMention.ts) -- same client class,
 * same timeout-only policy (no retry: a signed write embeds its nonce, so
 * retrying a client-side timeout after the server already accepted it would
 * resend the same nonce and get rejected as replay, masking a real success as
 * a failure). The only difference is which identity signs: the caller must
 * pass Agent B's `TechnocoreIdentity` (from verifier/identity.ts), never
 * Radar's -- this file has no way to load identity.json itself, by design.
 */

import { fetchWithTimeout } from "../mentions/http.js";
import { TechnocoreClient } from "../technocore.js";
import type { TechnocoreIdentity } from "../identity.js";
import type { VerificationResult } from "./types.js";

export interface VerificationSubject {
  findingId: string;
  canonicalUrl: string;
  originalFinding: string;
}

export function formatVerificationMessage(subject: VerificationSubject, result: VerificationResult, reason: string): string {
  const lines = [
    "Technocore Verifier",
    "",
    `Finding: ${subject.findingId}`,
    `Result: ${result}`,
    "",
    "Original finding:",
    subject.originalFinding,
    "",
    "Reason:",
    reason,
    "",
    "Source:",
    subject.canonicalUrl,
  ];
  return lines.join("\n");
}

export interface PublishedVerification {
  seq: number;
}

export type SendVerificationFn = (room: string, text: string) => Promise<PublishedVerification>;

/**
 * The real sender: TechnocoreClient signing with Agent B's identity, over
 * this feature's HTTP_TIMEOUT_MS, no retry -- see the file-level comment.
 *
 * IMPORTANT: `identity` is always passed explicitly via `{ identity }`.
 * `sendSignedMessage` / `buildSignedMessageRequest` fall back to loading
 * `.technocore/identity.json` (Radar's identity) from disk whenever no
 * `identity` option is given -- omitting it here would silently make the
 * Verifier sign as Radar.
 */
export function createTechnocoreVerifierSender(identity: TechnocoreIdentity, timeoutMs: number): SendVerificationFn {
  const client = new TechnocoreClient({
    fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, timeoutMs),
  });
  return async (room, text) => {
    const { posted } = await client.sendSignedMessage(room, text, { identity });
    return { seq: posted.seq };
  };
}
