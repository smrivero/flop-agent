import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMentions } from "./run.js";
import { openDatabase, getFindingByFindingId } from "./database.js";
import type { MentionsConfig } from "./config.js";
import type { SearchProvider, SearchResult } from "./types.js";

/** Captures everything console.log prints during `fn`, then restores it. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

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
    publishContentHash: false,
    publishDailyStatus: false,
    publishRadarState: false,
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
    analyze: async (input) => ({ related: input.url.includes("relevant") && !input.url.includes("ir"), finding: "x" }),
  });

  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("example.com/relevant"));
  assert.equal(summary.rejected, 1);
  assert.equal(summary.published, 1);
});

test("run: GENERATE_SUMMARY=false never includes an AI finding even if analysis returns one", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, generateSummary: false, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({ "only query": [{ url: "https://example.com/post", title: "t", snippet: "s" }] });
  const sent: string[] = [];

  await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => { sent.push(text); return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze: async () => ({ related: true, finding: "this should not appear" }),
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

// -- persistent backlog ---------------------------------------------------

test("backlog: candidates beyond MAX_POSTS_PER_RUN are not lost -- a later run publishes them", async () => {
  const config = baseConfig({ maxPostsPerRun: 3 });
  const provider = new FakeSearchProvider({ "only query": resultsNamed(8) });
  const sent: string[] = [];
  const deps = { searchProvider: provider, sendMessage: async (_room: string, text: string) => { sent.push(text); return { seq: sent.length }; } };

  const first = await runMentions(config, { dryRun: false }, deps);
  assert.equal(first.published, 3); // only the budget for this run
  assert.equal(first.new, 8); // but all 8 were discovered and registered

  // Second run: the search provider returns the SAME 8 results again (as it
  // would in real life, since nothing new happened) -- every one of them is
  // already known (3 published + 5 backlogged), so summary.new should be 0...
  const second = await runMentions(config, { dryRun: false }, deps);
  assert.equal(second.new, 0);
  // ...yet 3 more get published anyway, pulled from the backlog left by the first run.
  assert.equal(second.published, 3);
  assert.equal(sent.length, 6);

  // Third run drains the last 2.
  const third = await runMentions(config, { dryRun: false }, deps);
  assert.equal(third.published, 2);
  assert.equal(sent.length, 8);

  // Nothing left to do on a fourth run.
  const fourth = await runMentions(config, { dryRun: false }, deps);
  assert.equal(fourth.published, 0);
});

test("backlog: a dry-run preview does not consume the backlog", async () => {
  const config = baseConfig({ maxPostsPerRun: 2 });
  const provider = new FakeSearchProvider({ "only query": resultsNamed(5) });
  let sendCalls = 0;
  const deps = { searchProvider: provider, sendMessage: async () => { sendCalls++; return { seq: sendCalls }; } };

  const real = await runMentions(config, { dryRun: false }, deps);
  assert.equal(real.published, 2); // 3 left in the backlog

  const previewSent: string[] = [];
  const dryRunResult = await runMentions(config, { dryRun: true }, {
    searchProvider: new FakeSearchProvider({ "only query": [] }), // no new search results this time
    sendMessage: async (_room, text) => { previewSent.push(text); return { seq: 1 }; },
  });
  assert.equal(dryRunResult.published, 2); // previews 2 of the 3 backlogged items
  assert.equal(previewSent.length, 0); // but never actually calls sendMessage

  // The backlog is untouched -- a real run right after still finds the same 3 pending.
  const followUp = await runMentions(config, { dryRun: false }, deps);
  assert.equal(followUp.published, 2);
  const final = await runMentions(config, { dryRun: false }, deps);
  assert.equal(final.published, 1);
});

// -- finding message format ---------------------------------------------------

test("message format: a published finding matches the Radar template exactly", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, generateSummary: true, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({
    "only query": [{ url: "https://example.com/article", title: "AI agents experiment with Technocore", snippet: "s" }],
  });
  const sent: string[] = [];

  await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => { sent.push(text); return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze: async () => ({
      related: true,
      finding: "The page mentions Technocore as an HTTP-accessible communication layer for autonomous agents.",
    }),
  });

  assert.equal(sent.length, 1);
  const lines = sent[0].split("\n");
  assert.equal(lines[0], "Technocore Radar");
  assert.equal(lines[1], "");
  assert.match(lines[2], /^Finding: radar-\d{8}-[0-9a-f]{6}$/);
  assert.equal(lines[3], "Source: example.com");
  assert.equal(lines[4], "Title: AI agents experiment with Technocore");
  assert.equal(lines[5], "");
  assert.equal(lines[6], "Finding:");
  assert.equal(lines[7], "The page mentions Technocore as an HTTP-accessible communication layer for autonomous agents.");
  assert.equal(lines[8], "");
  assert.equal(lines[9], "Source:");
  assert.equal(lines[10], "https://example.com/article");
});

test("message format: PUBLISH_CONTENT_HASH=true adds a short evidence line; false omits it", async () => {
  const analyze = async () => ({ related: true, finding: "A finding." });

  const withHash = baseConfig({
    useOpenAi: true, filterWithOpenAi: true, generateSummary: true, publishContentHash: true, openAiApiKey: "k", openAiModel: "m",
  });
  const sentWithHash: string[] = [];
  await runMentions(withHash, { dryRun: false }, {
    searchProvider: new FakeSearchProvider({ "only query": [{ url: "https://example.com/a", title: "t", snippet: "s" }] }),
    sendMessage: async (_room, text) => { sentWithHash.push(text); return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze,
  });
  assert.match(sentWithHash[0], /Evidence: sha256:[0-9a-f]{8}$/);

  const withoutHash = baseConfig({
    useOpenAi: true, filterWithOpenAi: true, generateSummary: true, publishContentHash: false, openAiApiKey: "k", openAiModel: "m",
  });
  const sentWithoutHash: string[] = [];
  await runMentions(withoutHash, { dryRun: false }, {
    searchProvider: new FakeSearchProvider({ "only query": [{ url: "https://example.com/b", title: "t", snippet: "s" }] }),
    sendMessage: async (_room, text) => { sentWithoutHash.push(text); return { seq: 1 }; },
    fetchArticleFn: async () => null,
    analyze,
  });
  assert.ok(!sentWithoutHash[0].includes("Evidence:"));
});

test("persistence: a published finding is fully retrievable via getFindingByFindingId", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, generateSummary: true, publishContentHash: true, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({
    "only query": [{ url: "https://example.com/article", title: "A title", snippet: "s" }],
  });
  let capturedFindingId = "";

  await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => {
      capturedFindingId = text.match(/Finding: (radar-\d{8}-[0-9a-f]{6})/)![1];
      return { seq: 42 };
    },
    fetchArticleFn: async () => null,
    analyze: async () => ({ related: true, finding: "A specific, checkable claim about Technocore." }),
  });

  const db = openDatabase(config.dbPath);
  const row = getFindingByFindingId(db, capturedFindingId);
  assert.ok(row);
  assert.equal(row!.canonical_url, "https://example.com/article");
  assert.equal(row!.title, "A title");
  assert.equal(row!.finding, "A specific, checkable claim about Technocore.");
  assert.equal(row!.status, "published");
  assert.equal(row!.technocore_message_id, "42");
  assert.ok(row!.content_hash);
  assert.ok(row!.checked_at);
  assert.ok(row!.published_at);
  assert.equal(row!.search_query, "only query");
  assert.equal(row!.search_provider, "tavily");
  db.close();
});

test("dry-run: prints the full [NEW FINDING] block and never sends", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, generateSummary: true, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({
    "only query": [{ url: "https://example.com/article", title: "A title", snippet: "s" }],
  });
  let sendCalls = 0;

  const output = await captureLogs(() =>
    runMentions(config, { dryRun: true }, {
      searchProvider: provider,
      sendMessage: async () => { sendCalls++; return { seq: 1 }; },
      fetchArticleFn: async () => null,
      analyze: async () => ({ related: true, finding: "A checkable claim." }),
    }).then(() => undefined),
  );

  assert.equal(sendCalls, 0);
  assert.match(output, /\[NEW FINDING\]/);
  assert.match(output, /Finding: radar-\d{8}-[0-9a-f]{6}/);
  assert.match(output, /Source: example\.com/);
  assert.match(output, /Title: A title/);
  assert.match(output, /A checkable claim\./);
  assert.match(output, /URL:\nhttps:\/\/example\.com\/article/);
  assert.match(output, /Would publish: YES/);
});

// -- mock Radar -> independent verification contract ---------------------------

test("mock verification: Bot B can fetch a finding and independently verify or reject it, using no real Technocore/OpenAI", async () => {
  const config = baseConfig({ useOpenAi: true, filterWithOpenAi: true, generateSummary: true, openAiApiKey: "k", openAiModel: "m" });
  const provider = new FakeSearchProvider({
    "only query": [{ url: "https://example.com/article", title: "AI agents and Technocore", snippet: "s" }],
  });
  let capturedFindingId = "";

  // Step 1-3: Radar discovers, analyzes, and publishes a finding.
  await runMentions(config, { dryRun: false }, {
    searchProvider: provider,
    sendMessage: async (_room, text) => {
      capturedFindingId = text.match(/Finding: (radar-\d{8}-[0-9a-f]{6})/)![1];
      return { seq: 1 };
    },
    fetchArticleFn: async () => null,
    analyze: async () => ({ related: true, finding: "The page describes agents coordinating over Technocore." }),
  });

  // Step 4: "Bot B" -- a separate, independent process -- looks the finding up
  // by its public ID. This is exactly what `--show-finding=<id>` exposes.
  const db = openDatabase(config.dbPath);
  const finding = getFindingByFindingId(db, capturedFindingId);
  assert.ok(finding, "Bot B must be able to find Radar's finding by ID alone");
  db.close();

  // Step 5: Bot B re-fetches the URL independently (mocked here -- never a real
  // network call in a test) and re-analyzes it with its OWN logic, not by
  // trusting Radar's conclusion.
  const mockRefetchedContent = "This page describes autonomous agents coordinating over the Technocore protocol.";
  function independentlyVerify(findingRow: NonNullable<typeof finding>, refetchedContent: string): "VERIFIED" | "REJECTED" {
    const claimTerms = findingRow.finding!.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
    const supportedTerms = claimTerms.filter((term) => refetchedContent.toLowerCase().includes(term));
    // A real Bot B would use its own model call here; this mock just checks
    // independent textual support, which is enough to prove the CONTRACT (the
    // finding carries everything needed to re-check it) without spending any
    // real OpenAI credits in a test.
    return supportedTerms.length / claimTerms.length > 0.5 ? "VERIFIED" : "REJECTED";
  }

  const resultForSupportingContent = independentlyVerify(finding!, mockRefetchedContent);
  assert.equal(resultForSupportingContent, "VERIFIED");

  const resultForUnrelatedContent = independentlyVerify(finding!, "This page is entirely about gardening tips.");
  assert.equal(resultForUnrelatedContent, "REJECTED");

  // The contract fields the README documents Bot B needs are all present.
  for (const field of ["finding_id", "canonical_url", "title", "finding", "content_hash", "checked_at"] as const) {
    assert.ok(field in finding!, `finding is missing contract field ${field}`);
  }
});
