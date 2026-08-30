/**
 * URL canonicalization for dedup. The goal is that two URLs pointing at "the same
 * page" hash identically, so a link seen through two different search queries (or
 * with different tracking params) is recognized as one mention, not two.
 */

import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
  "gclid",
  "ref",
  "source",
]);

export class UrlCanonicalizeError extends Error {}

/**
 * Canonical form: lowercase scheme/host, default ports stripped, fragment
 * dropped, tracking params removed, remaining params sorted for determinism,
 * and a trailing slash removed except on the bare root path.
 */
export function canonicalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlCanonicalizeError(`not a valid absolute URL: ${JSON.stringify(rawUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlCanonicalizeError(`unsupported scheme: ${url.protocol}`);
  }

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }

  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** SHA-256 of the canonical URL, hex-encoded -- the dedup key stored alongside it. */
export function hashCanonicalUrl(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl, "utf8").digest("hex");
}

export function extractDomain(canonicalUrl: string): string {
  return new URL(canonicalUrl).hostname;
}
