/**
 * A "finding" is what a mention becomes once it's been checked: a stable,
 * independently-referenceable ID plus enough evidence (content hash, when it
 * was checked, which search produced it) that another agent -- Bot B, holding
 * its own separate DID -- can look the finding up, re-fetch the source
 * independently, and confirm or reject Radar's claim without trusting Radar's
 * word for it.
 */

import { createHash } from "node:crypto";
import { hashCanonicalUrl } from "./canonicalize.js";

/**
 * `radar-YYYYMMDD-<first 6 hex chars of SHA256(canonical_url)>`. Computed once,
 * at discovery time, from the *discovery* date -- never recomputed later, so a
 * retry (same row, `status=publish_failed` -> retried) keeps the same ID.
 * Deliberately not a counter: a counter changes meaning if the database is
 * ever rebuilt; this is a pure function of (date, URL).
 */
export function generateFindingId(canonicalUrl: string, discoveredAt: Date = new Date()): string {
  const dateComponent = discoveredAt.toISOString().slice(0, 10).replace(/-/g, "");
  const hashComponent = hashCanonicalUrl(canonicalUrl).slice(0, 6);
  return `radar-${dateComponent}-${hashComponent}`;
}

/** SHA-256 of whatever text was actually used to produce the finding (the
 * normalized extracted page content, or title+snippet when no page fetch
 * succeeded) -- the evidence a re-verifier can check their own fetch against. */
export function hashContent(normalizedContent: string): string {
  return createHash("sha256").update(normalizedContent, "utf8").digest("hex");
}

/** Short form for the optional `Evidence: sha256:<short>` message line --
 * never the full hash in the public message, always the full hash in SQLite. */
export function shortHash(fullHash: string, length = 8): string {
  return fullHash.slice(0, length);
}
