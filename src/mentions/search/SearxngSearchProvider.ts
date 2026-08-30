/** SearXNG's JSON API: `GET /search?q=<query>&format=json` on a self-hosted instance. */

import { fetchWithRetry } from "../http.js";
import type { SearchProvider, SearchResult } from "../types.js";

export interface SearxngOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

interface SearxngApiResult {
  url: string;
  title?: string;
  content?: string;
  publishedDate?: string;
}

export class SearxngSearchProvider implements SearchProvider {
  constructor(private readonly options: SearxngOptions) {}

  async search(query: string): Promise<SearchResult[]> {
    const url = new URL("/search", this.options.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const response = await fetchWithRetry(
      url.toString(),
      { method: "GET" },
      { timeoutMs: this.options.timeoutMs, maxRetries: this.options.maxRetries },
    );

    if (!response.ok) {
      throw new Error(`SearXNG search failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { results?: SearxngApiResult[] };
    return (body.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? "",
      snippet: r.content ?? "",
      publishedDate: r.publishedDate,
    }));
  }
}
