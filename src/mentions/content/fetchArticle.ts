/** Best-effort page fetch for OpenAI analysis. Failure is expected and handled --
 * callers fall back to the search result's title/snippet, never treat this as fatal. */

import { fetchWithRetry } from "../http.js";

export interface FetchArticleOptions {
  timeoutMs: number;
  maxRetries: number;
}

export async function fetchArticle(url: string, options: FetchArticleOptions): Promise<string | null> {
  try {
    const response = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "flop-agent-technocore-mentions/1.0 (+https://technocore.chat)" } },
      { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries },
    );
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && contentType !== "") {
      return null; // don't try to "read" a PDF/image/etc as HTML
    }
    return await response.text();
  } catch {
    return null;
  }
}
