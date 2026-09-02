/** Best-effort page fetch for OpenAI analysis. Failure is expected and handled --
 * callers fall back to the search result's title/snippet, never treat this as fatal. */

import { fetchWithRetry } from "../http.js";

export interface FetchArticleOptions {
  timeoutMs: number;
  maxRetries: number;
}

/** `kind` is the discriminant. "blocked" (HTTP 403/429) specifically means
 * "the site refused us on purpose" (bot protection, rate limiting) -- distinct
 * from a transient network error or an unrelated status code, and worth
 * telling callers apart from a generic "error". */
export type FetchArticleClassifiedResult = { kind: "ok"; html: string } | { kind: "blocked"; status: number } | { kind: "error" };

export async function fetchArticleClassified(url: string, options: FetchArticleOptions): Promise<FetchArticleClassifiedResult> {
  try {
    const response = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "flop-agent-technocore-mentions/1.0 (+https://technocore.chat)" } },
      { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries },
    );
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        return { kind: "blocked", status: response.status };
      }
      return { kind: "error" };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && contentType !== "") {
      return { kind: "error" }; // don't try to "read" a PDF/image/etc as HTML
    }
    return { kind: "ok", html: await response.text() };
  } catch {
    return { kind: "error" };
  }
}

/** Thin wrapper preserving the original string|null contract for existing
 * callers (the mentions pipeline) that don't need to tell failure kinds apart. */
export async function fetchArticle(url: string, options: FetchArticleOptions): Promise<string | null> {
  const result = await fetchArticleClassified(url, options);
  return result.kind === "ok" ? result.html : null;
}
