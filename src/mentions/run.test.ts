import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMentions } from "./run.js";
import { openDatabase } from "./database.js";
import type { MentionsConfig } from "./config.js";
import type { SearchProvider, SearchResult } from "./types.js";

/** Never touches Tavily/SearXNG -- a fixed, in-memory result set the test controls. */
class FakeSearchProvider implements SearchProvider {
  calls: string[] = [];
  constructor(private readonly resultsByQuery: Record<string, SearchResult[]>) {}
  async search(query: string): Promise<SearchResult[]> {
    this.calls.push(query);
    return this.resultsByQuery[query] ?? [];
  }
}

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-run-test-"));
  return { dbPath: join(dir, "mentions.sqlite3"), lockPath: join(dir, "mentions.lock") };
}

function baseConfig(overrides: Partial<MentionsConfig> = {}): MentionsConfig {
  const { dbPath, lockPath } = tempPaths();
  return {
    searchProvider: "tavily",
    tavilySearchDepth: "basic",
    tavilyMaxResults: 10,
    searxngUrl: "http://localhost:8888",
    searchQueries: ["only query"],
    queriesPerRun: 1,
    useOpenAi: false,
    filterWithOpenAi: false,
    generateSummary: false,
    maxContentChars: 12000,
    technocoreRoom: "d-technocore-links",
    maxPostsPerRun: 5,
    includeOfficialSources: false,
    excludedDomains: [],
    httpTimeoutMs: 15000,
    maxRetries: 0,
    publishIfAnalysisFails: true,
    dbPath,
    lockPath,
    ...overrides,
  };
}

function resultsNamed(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/article-${i}`,
    title: `Article ${i}`,
    snippet: `snippet ${i}`,
    publishedDate: `2026-08-${String(20 - i).padStart(2, "0")}`, // descending -- article-0 is newest
  }));
}

test("run: dry-run publishes nothing for real and writes nothing to the database", async () => {
  const config = baseConfig();
  const provider = new FakeSearchProvider({ "only query": resultsNamed(3) });
  let sendCalls = 0;

  const summary = await runMentions(config, { dryRun: true }, {
    searchProvider: provider,
    sendMessage: async () => { sendCalls++; return { seq: 1 }; },
  });

  assert.equal(sendCalls, 0);
  assert.equal(summary.published, 3);

  const db = openDatabase(config.dbPath);
  const row = db.prepare("SELECT COUNT(*) as c FROM mentions").get() as { c: number };
  assert.equal(row.c, 0);
  db.close();
});

test("run: MAX_POSTS_PER_RUN caps how many messages get sent", async () => {
  const config = baseConfig({ maxPostsPerRun: 2 });
  const provider = new FakeSearchProvider({ "only query": resultsNamed(5) });
  const sent: string[] = [];

  const summary = await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => { sent.push(text); return { seq: sent.length }; },
  });

  assert.equal(sent.length, 2);
  assert.equal(summary.published, 2);
  assert.equal(summary.new, 5);
});

test("run: --limit overrides maxPostsPerRun for a single invocation", async () => {
  const config = baseConfig({ maxPostsPerRun: 5 });
  const provider = new FakeSearchProvider({ "only query": resultsNamed(5) });
  let sendCalls = 0;

  const summary = await runMentions(config, { dryRun: false, limit: 1 }, {
    searchProvider: provider,
    sendMessage: async () => { sendCalls++; return { seq: sendCalls }; },
  });

  assert.equal(sendCalls, 1);
  assert.equal(summary.published, 1);
});

test("run: a URL published in a previous run is never published again", async () => {
  const config = baseConfig({ maxPostsPerRun: 10 });
  const provider = new FakeSearchProvider({ "only query": resultsNamed(2) });
  let sendCalls = 0;
  const deps = { searchProvider: provider, sendMessage: async () => { sendCalls++; return { seq: sendCalls }; } };

  const first = await runMentions(config, { dryRun: false }, deps);
  assert.equal(first.published, 2);
  assert.equal(sendCalls, 2);

  // Second run, same DB, same search results -- everything should dedupe.
  const second = await runMentions(config, { dryRun: false }, deps);
  assert.equal(second.published, 0);
  assert.equal(second.duplicates, 2);
  assert.equal(sendCalls, 2); // unchanged -- no new sends
});

test("run: same URL returned by two different queries in one run is only published once", async () => {
  const config = baseConfig({ searchQueries: ["q1", "q2"], queriesPerRun: 2, maxPostsPerRun: 10 });
  const shared: SearchResult = { url: "https://example.com/same-article", title: "Same", snippet: "s" };
  const provider = new FakeSearchProvider({ q1: [shared], q2: [shared] });
  let sendCalls = 0;

  const summary = await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async () => { sendCalls++; return { seq: sendCalls }; },
  });

  assert.equal(sendCalls, 1);
  assert.equal(summary.new, 1);
  assert.equal(summary.duplicates, 1);
});

test("run: excluded domains are never published even when brand new", async () => {
  const config = baseConfig({ excludedDomains: ["excluded.example"] });
  const provider = new FakeSearchProvider({
    "only query": [
      { url: "https://excluded.example/post", title: "t", snippet: "s" },
      { url: "https://ok.example/post", title: "t", snippet: "s" },
    ],
  });
  const sent: string[] = [];

  await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => { sent.push(text); return { seq: 1 }; },
  });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("ok.example"));
});

test("run: FILTER_WITH_OPENAI rejects mentions the analyzer marks irrelevant", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({
    "only query": [
      { url: "https://example.com/relevant", title: "t", snippet: "s" },
      { url: "https://example.com/irrelevant", title: "t", snippet: "s" },
    ],
  });
  const sent: string[] = [];

  const summary = await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => { sent.push(text); return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze: async (input) => ({ relevant: input.url.includes("relevant") && !input.url.includes("ir"), summary: "x" }),
  });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("example.com/relevant"));
  assert.equal(summary.rejected, 1);
  assert.equal(summary.published, 1);
});

test("run: GENERATE_SUMMARY=false never includes an AI summary even if analysis returns one", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, generateSummary: false, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({ "only query": [{ url: "https://example.com/post", title: "t", snippet: "s" }] });
  const sent: string[] = [];

  await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => { sent.push(text); return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze: async () => ({ relevant: true, summary: "this should not appear" }),
  });

  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("this should not appear"));
});

test("run: an OpenAI failure with PUBLISH_IF_ANALYSIS_FAILS=false skips that mention instead of publishing", async () => {
  const config = baseConfig({
    useOpenAi: true,
    filterWithOpenAi: true,
    openAiApiKey: "k",
    openAiModel: "m",
    publishIfAnalysisFails: false,
  });
  const provider = new FakeSearchProvider({ "only query": [{ url: "https://example.com/post", title: "t", snippet: "s" }] });
  let sendCalls = 0;

  const summary = await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async () => { sendCalls++; return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze: async () => { throw new Error("boom"); },
  });

  assert.equal(sendCalls, 0);
  assert.equal(summary.rejected, 1);
});
