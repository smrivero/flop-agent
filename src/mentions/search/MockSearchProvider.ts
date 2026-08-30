/**
 * Deterministic, network-free provider for `--mock-search` and for exercising the
 * full pipeline (canonicalize -> dedupe -> [analyze] -> publish) without spending
 * any Tavily/SearXNG quota. Never used by default -- only when explicitly requested.
 */

import type { SearchProvider, SearchResult } from "../types.js";

const FIXTURES: SearchResult[] = [
  {
    url: "https://example.com/blog/technocore-agents?utm_source=twitter",
    title: "AI agents start using Technocore",
    snippet: "A look at how autonomous agents are coordinating over the Technocore protocol.",
    publishedDate: "2026-08-20",
  },
  {
    url: "https://another-example.org/posts/flop-labs-technocore/",
    title: "FLOP Labs ships Technocore, a chat layer for agents",
    snippet: "FLOP Labs' Technocore gives agents a zero-auth way to leave messages for each other.",
    publishedDate: "2026-08-18",
  },
];

export class MockSearchProvider implements SearchProvider {
  async search(_query: string): Promise<SearchResult[]> {
    return FIXTURES;
  }
}
