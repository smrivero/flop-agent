/**
 * Official Tavily REST API (https://docs.tavily.com/) -- no SDK, just fetch, to
 * keep this project's zero-extra-dependency philosophy for anything that's just
 * "call a JSON endpoint."
 *
 * Cost discipline: one HTTP call per query, returning up to `maxResults` results
 * in that single call -- never one request per result. How many queries actually
 * run per invocation is controlled entirely by config.ts / database.ts's query
 * rotation, not by this class.
 */

import { fetchWithRetry } from "../http.js";
import type { SearchProvider, SearchResult } from "../types.js";

export interface TavilyOptions {
  apiKey: string;
  searchDepth: "basic" | "advanced";
  maxResults: number;
  timeoutMs: number;
  maxRetries: number;
}

interface TavilyApiResult {
  url: string;
  title?: string;
  content?: string;
  published_date?: string;
}

export class TavilySearchProvider implements SearchProvider {
  constructor(private readonly options: TavilyOptions) {}

  async search(query: string): Promise<SearchResult[]> {
    const response = await fetchWithRetry(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.options.apiKey,
          query,
          search_depth: this.options.searchDepth,
          max_results: this.options.maxResults,
        }),
      },
      { timeoutMs: this.options.timeoutMs, maxRetries: this.options.maxRetries },
    );

    if (!response.ok) {
      // Never include the request body/headers in the error -- they carry the API key.
      throw new Error(`Tavily search failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { results?: TavilyApiResult[] };
    return (body.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? "",
      snippet: r.content ?? "",
      publishedDate: r.published_date,
    }));
  }
}
