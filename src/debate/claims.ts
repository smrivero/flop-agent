/**
 * Structured claim tracking, without a second OpenAI call: the model is asked
 * (prompt.ts) to end its response with one machine-readable trailer line after
 * a fixed delimiter, listing the factual claims it discussed this turn and
 * whether they held up. This module splits that trailer off the public
 * message (the trailer is never published to Technocore -- see #13) and turns
 * it into ClaimRecord objects state.ts can persist.
 *
 * Absence or malformed JSON in the trailer is never a hard failure -- it just
 * means zero claims were recorded for this turn. The natural-language message
 * is the thing that actually matters and is always usable on its own.
 */

import type { AgentId, ClaimRecord, ClaimStatus } from "./types.js";

export const CLAIMS_DELIMITER = "===CLAIMS===";

const VALID_STATUSES: ClaimStatus[] = ["unverified", "verified", "disputed", "corrected"];

export interface RawClaim {
  claim: string;
  status: ClaimStatus;
  sources?: string[];
}

export interface SplitModelOutput {
  /** The natural-language message -- everything before the delimiter, trimmed. */
  message: string;
  claims: RawClaim[];
}

function parseClaimsJson(raw: string): RawClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const claims: RawClaim[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.claim !== "string" || obj.claim.trim() === "") continue;
    if (typeof obj.status !== "string" || !VALID_STATUSES.includes(obj.status as ClaimStatus)) continue;
    const sources = Array.isArray(obj.sources) ? obj.sources.filter((s): s is string => typeof s === "string") : [];
    claims.push({ claim: obj.claim.trim(), status: obj.status as ClaimStatus, sources });
  }
  return claims;
}

/** Splits the model's raw output on the LAST occurrence of the claims
 * delimiter (in case a debate message itself happens to quote the string --
 * unlikely, but the last occurrence is always the intended trailer). */
export function splitModelOutput(rawText: string): SplitModelOutput {
  const index = rawText.lastIndexOf(CLAIMS_DELIMITER);
  if (index === -1) return { message: rawText.trim(), claims: [] };

  const message = rawText.slice(0, index).trim();
  const trailer = rawText.slice(index + CLAIMS_DELIMITER.length);
  return { message, claims: parseClaimsJson(trailer) };
}

/**
 * Turns parsed trailer claims into ClaimRecord additions (still missing
 * `id` -- state.ts assigns that from its own counter). Heuristic for
 * `author`/`verifiedBy`: an "unverified" claim is the speaker introducing
 * something new; anything the speaker reports as verified/disputed/corrected
 * is treated as a check of a claim the OPPONENT is presumed to have made
 * (the common conversational shape: A claims something, B checks it next
 * turn) -- not a perfect attribution, but a reasonable default with no extra
 * bookkeeping required from the model.
 */
export function buildClaimRecords(claims: RawClaim[], speakerId: AgentId, opponentId: AgentId): Omit<ClaimRecord, "id">[] {
  return claims.map((c) => {
    if (c.status === "unverified") {
      return { author: speakerId, claim: c.claim, status: c.status, sources: c.sources ?? [] };
    }
    return { author: opponentId, claim: c.claim, status: c.status, verifiedBy: speakerId, sources: c.sources ?? [] };
  });
}
