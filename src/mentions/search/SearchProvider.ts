import type { MentionsConfig } from "../config.js";
import type { SearchProvider } from "../types.js";
import { TavilySearchProvider } from "./TavilySearchProvider.js";
import { SearxngSearchProvider } from "./SearxngSearchProvider.js";

export type { SearchProvider } from "../types.js";

export class SearchProviderConfigError extends Error {}

/**
 * Provider selection lives here, not in run.ts -- adding a third provider means
 * adding a file plus one line in this switch, nothing else changes.
 */
export function getSearchProvider(config: MentionsConfig): SearchProvider {
  switch (config.searchProvider) {
    case "tavily": {
      if (!config.tavilyApiKey) {
        throw new SearchProviderConfigError("TAVILY_API_KEY is required when SEARCH_PROVIDER=tavily");
      }
      return new TavilySearchProvider({
        apiKey: config.tavilyApiKey,
        searchDepth: config.tavilySearchDepth,
        maxResults: config.tavilyMaxResults,
        timeoutMs: config.httpTimeoutMs,
        maxRetries: config.maxRetries,
      });
    }
    case "searxng":
      return new SearxngSearchProvider({
        baseUrl: config.searxngUrl,
        timeoutMs: config.httpTimeoutMs,
        maxRetries: config.maxRetries,
      });
  }
}
