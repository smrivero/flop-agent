import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError, shouldUseOpenAi, resolveExcludedDomains, isDomainExcluded } from "./config.js";

test("config: sane defaults with an empty environment", () => {
  const config = loadConfig({});
  assert.equal(config.searchProvider, "tavily");
  assert.equal(config.tavilySearchDepth, "basic");
  assert.equal(config.tavilyMaxResults, 10);
  assert.equal(config.queriesPerRun, 2);
  assert.equal(config.searchQueries.length, 5);
  assert.equal(config.useOpenAi, false);
  assert.equal(config.technocoreRoom, "d-technocore-links");
  assert.equal(config.maxPostsPerRun, 5);
  assert.equal(config.includeOfficialSources, false);
  assert.equal(config.httpTimeoutMs, 15000);
  assert.equal(config.maxRetries, 2);
  assert.equal(config.publishIfAnalysisFails, true);
});

test("config: SEARCH_QUERIES is pipe-separated and trimmed", () => {
  const config = loadConfig({ SEARCH_QUERIES: " Technocore FLOP | technocore.chat |Technocore inference " });
  assert.deepEqual(config.searchQueries, ["Technocore FLOP", "technocore.chat", "Technocore inference"]);
});

test("config: EXCLUDED_DOMAINS is comma-separated and lowercased", () => {
  const config = loadConfig({ EXCLUDED_DOMAINS: "Technocore.chat, GitHub.com" });
  assert.deepEqual(config.excludedDomains, ["technocore.chat", "github.com"]);
});

test("config: rejects an invalid SEARCH_PROVIDER", () => {
  assert.throws(() => loadConfig({ SEARCH_PROVIDER: "bing" }), ConfigError);
});

test("config: rejects QUERIES_PER_RUN below 1", () => {
  assert.throws(() => loadConfig({ QUERIES_PER_RUN: "0" }), ConfigError);
});

test("config: requires OPENAI_API_KEY and OPENAI_MODEL when USE_OPENAI + (filter or summary) is on", () => {
  assert.throws(() => loadConfig({ USE_OPENAI: "true", FILTER_WITH_OPENAI: "true" }), ConfigError);
  assert.throws(
    () => loadConfig({ USE_OPENAI: "true", GENERATE_SUMMARY: "true", OPENAI_API_KEY: "sk-x" }),
    ConfigError,
  );
  assert.doesNotThrow(() =>
    loadConfig({ USE_OPENAI: "true", GENERATE_SUMMARY: "true", OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "gpt-4o-mini" }),
  );
});

test("config: USE_OPENAI alone (no filter, no summary) does not require API credentials", () => {
  assert.doesNotThrow(() => loadConfig({ USE_OPENAI: "true" }));
});

test("shouldUseOpenAi: only true when USE_OPENAI and (filter or summary) are both on", () => {
  assert.equal(shouldUseOpenAi(loadConfig({})), false);
  assert.equal(shouldUseOpenAi(loadConfig({ USE_OPENAI: "true" })), false);
  assert.equal(
    shouldUseOpenAi(loadConfig({ USE_OPENAI: "true", FILTER_WITH_OPENAI: "true", OPENAI_API_KEY: "k", OPENAI_MODEL: "m" })),
    true,
  );
});

test("resolveExcludedDomains / isDomainExcluded: official sources excluded by default, subdomains match", () => {
  const excluded = resolveExcludedDomains(loadConfig({}));
  assert.equal(isDomainExcluded("technocore.chat", excluded), true);
  assert.equal(isDomainExcluded("docs.github.com", excluded), true); // subdomain of an excluded domain
  assert.equal(isDomainExcluded("example.com", excluded), false);
});

test("resolveExcludedDomains: INCLUDE_OFFICIAL_SOURCES=true drops the default official list", () => {
  const excluded = resolveExcludedDomains(loadConfig({ INCLUDE_OFFICIAL_SOURCES: "true" }));
  assert.equal(isDomainExcluded("technocore.chat", excluded), false);
});
