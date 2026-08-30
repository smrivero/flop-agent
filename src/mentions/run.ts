/**
 * Orchestrates one mentions run: search -> canonicalize -> dedupe -> [analyze] ->
 * publish -> persist. No argv/stdio here (cli.ts owns that) and no hardcoded
 * providers (search/publish/analyze are all passed in or defaulted), so this
 * whole pipeline is unit-testable with fakes and never has to touch the network,
 * SQLite state from a previous test, or the real Technocore identity.
 */

import { advanceQueryRotation, insertDiscovered, isKnownUrl, markAnalysisFailed, markPublishFailed, markPublished, markRejected, openDatabase, peekQueryBatch, type MentionsDb } from "./database.js";
import { canonicalizeUrl, extractDomain, hashCanonicalUrl, UrlCanonicalizeError } from "./canonicalize.js";
import { isDomainExcluded, resolveExcludedDomains, shouldUseOpenAi, type MentionsConfig } from "./config.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { getSearchProvider } from "./search/SearchProvider.js";
import { fetchArticle } from "./content/fetchArticle.js";
import { extractContent } from "./content/extractContent.js";
import { analyzeMention } from "./ai/analyzeMention.js";
import { createTechnocoreSender, formatMessage, type SendMessageFn } from "./publisher/publishMention.js";
import type { AnalysisResult, Candidate, RunSummary, SearchProvider } from "./types.js";

export interface RunOptions {
  dryRun: boolean;
  /** Overrides config.maxPostsPerRun for this invocation only (e.g. --limit=2). */
  limit?: number;
}

export interface RunDeps {
  searchProvider?: SearchProvider;
  sendMessage?: SendMessageFn;
  analyze?: typeof analyzeMention;
  fetchArticleFn?: typeof fetchArticle;
}

function logLine(text: string): void {
  console.log(text);
}

function logEvent(tag: string, fields: Record<string, unknown>): void {
  const lines = [`[${tag}]`, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)];
  console.log(lines.join("\n"));
}

const emptySummary = (): RunSummary => ({ queries: 0, results: 0, duplicates: 0, new: 0, rejected: 0, published: 0 });

interface RankedResult {
  candidate: Candidate;
  position: number;
}

export async function runMentions(config: MentionsConfig, options: RunOptions, deps: RunDeps = {}): Promise<RunSummary> {
  logLine("[run] starting");
  if (options.dryRun) logLine("[run] dry-run mode -- no writes to Technocore or the database");

  let release: () => void;
  try {
    release = acquireLock(config.lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) {
      logLine("[run] another execution is active, exiting");
      return emptySummary();
    }
    throw err;
  }

  const db = openDatabase(config.dbPath);
  try {
    return await runOnce(db, config, options, deps);
  } finally {
    db.close();
    release();
    logLine("[run] finished");
  }
}

async function runOnce(db: MentionsDb, config: MentionsConfig, options: RunOptions, deps: RunDeps): Promise<RunSummary> {
  const summary = emptySummary();

  const queries = peekQueryBatch(db, config.searchQueries, config.queriesPerRun);
  if (!options.dryRun) advanceQueryRotation(db, config.searchQueries, config.queriesPerRun);
  summary.queries = queries.length;

  const provider = deps.searchProvider ?? getSearchProvider(config);
  const excludedDomains = resolveExcludedDomains(config);
  const seenThisRun = new Set<string>();
  const ranked: RankedResult[] = [];

  for (const query of queries) {
    logEvent("search", { provider: config.searchProvider, query: JSON.stringify(query) });
    let results;
    try {
      results = await provider.search(query);
    } catch (err) {
      logEvent("search", { provider: config.searchProvider, query: JSON.stringify(query), error: String((err as Error).message ?? err) });
      continue;
    }
    logEvent("search", { results: results.length });
    summary.results += results.length;

    results.forEach((result, position) => {
      let canonicalUrl: string;
      try {
        canonicalUrl = canonicalizeUrl(result.url);
      } catch (err) {
        if (err instanceof UrlCanonicalizeError) return; // unusable URL, quietly skip
        throw err;
      }
      const domain = extractDomain(canonicalUrl);
      const urlHash = hashCanonicalUrl(canonicalUrl);

      if (isDomainExcluded(domain, excludedDomains)) {
        summary.duplicates++;
        return;
      }
      if (seenThisRun.has(urlHash) || isKnownUrl(db, canonicalUrl, urlHash)) {
        logEvent("dedupe", { duplicate: canonicalUrl });
        summary.duplicates++;
        return;
      }
      seenThisRun.add(urlHash);
      logEvent("dedupe", { new: canonicalUrl });

      ranked.push({
        position,
        candidate: {
          canonicalUrl,
          urlHash,
          originalUrl: result.url,
          title: result.title,
          domain,
          snippet: result.snippet,
          publishedDate: result.publishedDate,
        },
      });
    });
  }

  summary.new = ranked.length;

  // Preferred order: published date (newest first), then rank within its own
  // search response. Missing dates sort after dated ones.
  ranked.sort((a, b) => {
    const da = a.candidate.publishedDate ?? "";
    const db_ = b.candidate.publishedDate ?? "";
    if (da !== db_) return db_.localeCompare(da);
    return a.position - b.position;
  });

  const effectiveLimit = options.limit ?? config.maxPostsPerRun;
  const analyze = deps.analyze ?? analyzeMention;
  const fetchArticleFn = deps.fetchArticleFn ?? fetchArticle;
  const sendMessage = deps.sendMessage ?? createTechnocoreSender(config);
  const useOpenAi = shouldUseOpenAi(config);

  let publishedCount = 0;
  for (const { candidate } of ranked) {
    if (publishedCount >= effectiveLimit) break;

    const id = options.dryRun ? undefined : insertDiscovered(db, candidate);

    let analysis: AnalysisResult = { relevant: true, summary: "" };

    if (useOpenAi) {
      const html = await fetchArticleFn(candidate.canonicalUrl, { timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries });
      logEvent("fetch", { url: candidate.canonicalUrl, success: html !== null });
      const content = html ? extractContent(html, config.maxContentChars) : undefined;

      try {
        analysis = await analyze(
          { title: candidate.title, url: candidate.canonicalUrl, snippet: candidate.snippet, content },
          { apiKey: config.openAiApiKey!, model: config.openAiModel!, timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries },
        );
        logEvent("openai", { url: candidate.canonicalUrl, relevant: analysis.relevant });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        logEvent("openai", { url: candidate.canonicalUrl, error: message });
        if (id !== undefined) markAnalysisFailed(db, id, message);
        if (!config.publishIfAnalysisFails) {
          summary.rejected++;
          continue;
        }
        analysis = { relevant: true, summary: "" }; // proceed unfiltered, no summary
      }
    }

    if (config.filterWithOpenAi && useOpenAi && !analysis.relevant) {
      if (id !== undefined) markRejected(db, id, "not relevant per OpenAI");
      summary.rejected++;
      continue;
    }

    const summaryText = config.generateSummary ? analysis.summary : undefined;
    const messageText = formatMessage(candidate, summaryText);

    if (options.dryRun) {
      logEvent("publish", { room: config.technocoreRoom, url: candidate.canonicalUrl, success: "dry_run" });
      logLine(`message:\n${messageText}`);
      publishedCount++;
      summary.published++;
      continue;
    }

    try {
      const posted = await sendMessage(config.technocoreRoom, messageText);
      markPublished(db, id!, config.technocoreRoom, String(posted.seq), summaryText ?? null);
      logEvent("publish", { room: config.technocoreRoom, url: candidate.canonicalUrl, success: true });
      publishedCount++;
      summary.published++;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      markPublishFailed(db, id!, message);
      logEvent("publish", { room: config.technocoreRoom, url: candidate.canonicalUrl, success: false });
    }
  }

  logEvent("summary", { ...summary });
  return summary;
}
