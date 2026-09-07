/**
 * Local HTTP wrapper for the protocol watcher. Deliberately NOT built on top
 * of mentions/http.ts's fetchWithRetry: that helper doesn't support a
 * response-size cap or a controlled redirect count, and this feature needs
 * both (a hostile or misconfigured server could otherwise serve an
 * unbounded body or an infinite redirect chain). `fetchWithTimeout`'s
 * AbortController primitive *is* reused as-is -- its interface already does
 * exactly what's needed for the per-attempt timeout, nothing about it needed
 * changing.
 *
 * mentions/http.ts itself is never modified.
 */

import { fetchWithTimeout } from "../mentions/http.js";

export const USER_AGENT = "flop-protocol-watcher/1.0 (+https://github.com/flop-labs; monitors public FLOP docs)";

export class ResponseTooLargeError extends Error {}
export class TooManyRedirectsError extends Error {}

/** A non-5xx HTTP failure (4xx): the request itself is wrong, so
 * conditionalFetch must not retry it -- retrying would just repeat the same
 * failure while burning quota, same rationale as mentions/http.ts. */
export class HttpStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface ConditionalFetchOptions {
  etag?: string;
  lastModified?: string;
  timeoutMs: number;
  maxRetries: number;
  maxRedirects: number;
  maxResponseBytes: number;
}

export interface ConditionalFetchResult {
  status: number;
  notModified: boolean;
  body: string;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  finalUrl: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the body up to `maxBytes`, throwing ResponseTooLargeError if the
 * stream (or a Content-Length header) says there's more than that. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number.parseInt(declaredLength, 10) > maxBytes) {
    throw new ResponseTooLargeError(`Content-Length ${declaredLength} exceeds the ${maxBytes}-byte cap`);
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(`response body exceeded the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * One conditional GET with a self-managed, capped redirect chain (so a
 * redirect loop or an oversized final body can't hang or blow up memory),
 * timeout + limited retry (network errors / 5xx only, matching
 * fetchWithRetry's own rationale -- a 4xx means the request itself is wrong).
 * 304 short-circuits immediately: no body is read, no retry is attempted.
 */
export async function conditionalFetch(url: string, options: ConditionalFetchOptions): Promise<ConditionalFetchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fetchOnceFollowingRedirects(url, options);
    } catch (err) {
      if (err instanceof ResponseTooLargeError || err instanceof TooManyRedirectsError) throw err;
      if (err instanceof HttpStatusError && err.status < 500) throw err; // 4xx: never retried
      lastError = err;
    }
    if (attempt < options.maxRetries) {
      await sleep(300 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchOnceFollowingRedirects(startUrl: string, options: ConditionalFetchOptions): Promise<ConditionalFetchResult> {
  let currentUrl = startUrl;
  for (let redirects = 0; redirects <= options.maxRedirects; redirects++) {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (options.etag) headers["If-None-Match"] = options.etag;
    if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

    const response = await fetchWithTimeout(currentUrl, { headers, redirect: "manual" }, options.timeoutMs);

    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      currentUrl = new URL(response.headers.get("location")!, currentUrl).toString();
      continue;
    }

    if (response.status === 304) {
      return { status: 304, notModified: true, body: "", finalUrl: currentUrl };
    }

    if (!response.ok) {
      throw new HttpStatusError(response.status, `HTTP ${response.status} ${response.statusText} for ${currentUrl}`);
    }

    const body = await readBodyCapped(response, options.maxResponseBytes);
    return {
      status: response.status,
      notModified: false,
      body,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      finalUrl: currentUrl,
    };
  }
  throw new TooManyRedirectsError(`more than ${options.maxRedirects} redirects starting at ${startUrl}`);
}
