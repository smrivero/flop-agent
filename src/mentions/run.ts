/**
 * Orchestrates one mentions run: search -> canonicalize -> dedupe -> persistent
 * backlog -> [analyze] -> publish -> persist. No argv/stdio here (cli.ts owns
 * that) and no hardcoded providers (search/publish/analyze are all passed in or
 * defaulted), so this whole pipeline is unit-testable with fakes and never has
 * to touch the network, SQLite state from a previous test, or the real
 * Technocore identity.
 *
 * Backlog, not "process or lose": every newly-deduped candidate is inserted as
 * `discovered` immediately, regardless of whether this run gets to it. Each run
 * then pulls up to `effectiveLimit` *pending* mentions -- oldest `discovered`
 * first, which naturally mixes in anything left over from earlier runs ahead of
 * this run's fresh finds. Nothing found is ever silently dropped; a big first
 * run just spreads its backlog over the following hours instead of guessing
 * whether to publish it all at once.
 *
 * The per-run limit is a budget on *attempts*, not successes: exactly
 * `effectiveLimit` mentions are considered per run (fetched/analyzed/published-
 * or-rejected), win or lose. A string of failures can no longer make one run
 * silently process far more than its budget while it keeps hunting for enough
 * successes.
 */

import {
  advanceQueryRotation,
  getPendingBacklog,
  insertDiscovered,
  isKnownUrl,
  markAnalysisFailed,
  markPublishFailed,
  markPublished,
  markRejected,
  openDatabase,
  peekQueryBatch,
  type MentionsDb,
} from "./database.js";
import { canonicalizeUrl, extractDomain, hashCanonicalUrl, UrlCanonicalizeError } from "./canonicalize.js";
import { isDomainExcluded, resolveExcludedDomains, shouldUseOpenAi, type MentionsConfig } from "./config.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { getSearchProvider } from "./search/SearchProvider.js";
import { fetchArticle } from "./content/fetchArticle.js";
import { extractContent } from "./content/extractContent.js";
import { analyzeMention } from "./ai/analyzeMention.js";
import { createTechnocoreSender, formatMessage, type SendMessageFn } from "./publisher/publishMention.js";
import type { AnalysisResult, Candidate, MentionRow, RunSummary, SearchProvider } from "./types.js";

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

/** The common shape the processing loop needs, whether an item came from the
 * persistent backlog (a MentionRow with an id) or -- dry-run preview only -- a
 * freshly-found Candidate that was never written to the database. */
interface QueueItem {
  /** Absent only for dry-run-preview items that were never inserted. */
  id?: number;
  canonicalUrl: string;
  title: string;
  domain: string;
  snippet: string;
}

function fromRow(row: MentionRow): QueueItem {
  return { id: row.id, canonicalUrl: row.canonical_url, title: row.title ?? "", domain: row.domain ?? "", snippet: row.snippet ?? "" };
}

function fromCandidate(c: Candidate): QueueItem {
  return { canonicalUrl: c.canonicalUrl, title: c.title, domain: c.domain, snippet: c.snippet };
}

function byDateThenPosition(a: { candidate: Candidate; position: number }, b: { candidate: Candidate; position: number }): number {
  const da = a.candidate.publishedDate ?? "";
  const db_ = b.candidate.publishedDate ?? "";
  if (da !== db_) return db_.localeCompare(da); // newest first; missing dates sort last
  return a.position - b.position;
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
  const freshlyFound: { candidate: Candidate; position: number }[] = [];

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

      freshlyFound.push({
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

  summary.new = freshlyFound.length;
  freshlyFound.sort(byDateThenPosition);

  const effectiveLimit = options.limit ?? config.maxPostsPerRun;

  // Register every new find as `discovered` immediately (real runs only) -- this
  // is what turns "didn't fit this run's budget" into "will be first in line
  // next run" instead of "gone". Then pull the actual work queue for THIS run
  // from the backlog table, oldest-pending-first, which naturally includes
  // whatever was just inserted alongside anything left over from before.
  let queue: QueueItem[];
  if (options.dryRun) {
    // No writes at all in dry-run: preview the real backlog (a read) followed by
    // this run's fresh finds (never persisted), capped the same way a real run
    // would be.
    const backlog = getPendingBacklog(db, effectiveLimit).map(fromRow);
    const remaining = Math.max(0, effectiveLimit - backlog.length);
    queue = [...backlog, ...freshlyFound.slice(0, remaining).map(({ candidate }) => fromCandidate(candidate))];
  } else {
    for (const { candidate } of freshlyFound) insertDiscovered(db, candidate);
    queue = getPendingBacklog(db, effectiveLimit).map(fromRow);
  }

  const analyze = deps.analyze ?? analyzeMention;
  const fetchArticleFn = deps.fetchArticleFn ?? fetchArticle;
  const sendMessage = deps.sendMessage ?? createTechnocoreSender(config);
  const useOpenAi = shouldUseOpenAi(config);

  for (const item of queue) {
    let analysis: AnalysisResult = { relevant: true, summary: "" };

    if (useOpenAi) {
      const html = await fetchArticleFn(item.canonicalUrl, { timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries });
      logEvent("fetch", { url: item.canonicalUrl, success: html !== null });
      const content = html ? extractContent(html, config.maxContentChars) : undefined;

      try {
        analysis = await analyze(
          { title: item.title, url: item.canonicalUrl, snippet: item.snippet, content },
          { apiKey: config.openAiApiKey!, model: config.openAiModel!, timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries },
        );
        logEvent("openai", { url: item.canonicalUrl, relevant: analysis.relevant });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        logEvent("openai", { url: item.canonicalUrl, error: message });
        if (item.id !== undefined) markAnalysisFailed(db, item.id, message);
        if (!config.publishIfAnalysisFails) {
          summary.rejected++;
          continue;
        }
        analysis = { relevant: true, summary: "" }; // proceed unfiltered, no summary
      }
    }

    if (config.filterWithOpenAi && useOpenAi && !analysis.relevant) {
      if (item.id !== undefined) markRejected(db, item.id, "not relevant per OpenAI");
      summary.rejected++;
      continue;
    }

    const summaryText = config.generateSummary ? analysis.summary : undefined;
    const messageText = formatMessage(item, summaryText);

    if (options.dryRun) {
      logEvent("publish", { room: config.technocoreRoom, url: item.canonicalUrl, success: "dry_run" });
      logLine(`message:\n${messageText}`);
      summary.published++;
      continue;
    }

    try {
      const posted = await sendMessage(config.technocoreRoom, messageText);
      markPublished(db, item.id!, config.technocoreRoom, String(posted.seq), summaryText ?? null);
      logEvent("publish", { room: config.technocoreRoom, url: item.canonicalUrl, success: true });
      summary.published++;
    } catch (err) {
      // Safe to log: TechnocoreError.message is a short "status + reason" string,
      // never headers, keys, or private key material.
      const message = (err as Error).message ?? String(err);
      markPublishFailed(db, item.id!, message);
      logEvent("publish", { room: config.technocoreRoom, url: item.canonicalUrl, success: false, error: message });
    }
  }

  logEvent("summary", { ...summary });
  return summary;
}
