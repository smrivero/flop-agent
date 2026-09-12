/**
 * Optional wire-level logging for every HTTP request this feature makes to
 * Technocore, gated behind SONNET_HTTP_DEBUG (default off -- this is a lot of
 * log volume on a 30s poll loop, and every other src/sonnet/*.ts module
 * already logs the decisions it makes from the data, not the transport).
 * Only wraps the `fetch` handed to *this feature's* TechnocoreClient
 * instances -- src/technocore.ts itself is untouched, so mentions/verifier/
 * debate/tclk (which also import it) are unaffected regardless of this flag.
 *
 * Logs method, full URL, request headers/body, and response status/
 * headers/body under [SONNET][HTTP] -- request and response share a
 * generated call id so a busy log can still be read as pairs. Bodies over
 * MAX_BODY_LOG_CHARS are truncated (room exports run 1-4MB; nobody wants
 * that inline in a log file) with the true byte length still printed.
 */

import { TechnocoreClient, type TechnocoreClientOptions } from "../technocore.js";
import type { SonnetConfig } from "./config.js";
import { sonnetLog } from "./logger.js";

const MAX_BODY_LOG_CHARS = 4000;

function truncate(body: string): string {
  if (body.length <= MAX_BODY_LOG_CHARS) return body;
  return `${body.slice(0, MAX_BODY_LOG_CHARS)}\n...[truncated, ${body.length} bytes total]`;
}

function headersToObject(headers: RequestInit["headers"] | Headers | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

let callCounter = 0;

/** Wraps a fetch implementation so every call is logged before it goes out
 * and after the response comes back. Never swallows or alters the response
 * -- the caller sees exactly what an unwrapped fetch would have returned. */
export function wrapFetchWithLogging(fetchImpl: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const id = ++callCounter;
    const method = init?.method ?? "GET";
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reqHeaders = headersToObject(init?.headers);
    const reqBody = typeof init?.body === "string" ? init.body : undefined;

    sonnetLog(
      "HTTP",
      `--> #${id} ${method} ${url}` +
        (Object.keys(reqHeaders).length ? ` headers=${JSON.stringify(reqHeaders)}` : "") +
        (reqBody ? ` body=${truncate(reqBody)}` : ""),
    );

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (err) {
      sonnetLog("HTTP", `<-- #${id} network error: ${(err as Error).message}`);
      throw err;
    }

    const respHeaders = headersToObject(response.headers);
    const cloned = response.clone();
    let bodyPreview = "";
    try {
      bodyPreview = truncate(await cloned.text());
    } catch {
      bodyPreview = "<unreadable body>";
    }
    sonnetLog(
      "HTTP",
      `<-- #${id} ${response.status} ${response.statusText} headers=${JSON.stringify(respHeaders)} body=${bodyPreview}`,
    );

    return response;
  };
  return wrapped;
}

/** Every src/sonnet/*.ts module that talks to Technocore should build its
 * default TechnocoreClient through this instead of `new TechnocoreClient({
 * baseUrl })` directly, so SONNET_HTTP_DEBUG=true logs every one of them
 * without each call site needing its own opt-in. Passing an explicit
 * `client` (as every test does) bypasses this entirely, same as before. */
export function createTechnocoreClient(config: SonnetConfig, extra: TechnocoreClientOptions = {}): TechnocoreClient {
  if (!config.httpDebug) return new TechnocoreClient({ baseUrl: config.technocoreBaseUrl, ...extra });
  const baseFetch = extra.fetchImpl ?? fetch;
  return new TechnocoreClient({ baseUrl: config.technocoreBaseUrl, ...extra, fetchImpl: wrapFetchWithLogging(baseFetch) });
}
