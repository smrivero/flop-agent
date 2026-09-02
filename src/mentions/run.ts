/**
 * Orchestrates one Technocore Radar run: search -> canonicalize -> dedupe ->
 * persistent/retryable backlog -> [analyze into a finding] -> publish ->
 * persist. No argv/stdio here (cli.ts owns that) and no hardcoded providers
 * (search/publish/analyze are all passed in or defaulted), so this whole
 * pipeline is unit-testable with fakes and never has to touch the network,
 * SQLite state from a previous test, or the real Technocore identity.
 *
 * Backlog, not "process or lose": every newly-deduped candidate is inserted as
 * `discovered` immediately (with its permanent finding_id assigned right
 * then), regardless of whether this run gets to it. `publish_failed` rows are
 * ALSO retryable -- a finding that was generated correctly but whose
 * Technocore write failed is retried with the SAME finding_id, never
 * regenerated. Each run pulls up to `effectiveLimit` pending mentions --
 * oldest first -- which naturally mixes in anything left over from earlier
 * runs ahead of this run's fresh finds. Nothing found is ever silently
 * dropped; a big first run just spreads its backlog over the following hours.
 *
 * The per-run limit is a budget on *attempts*, not successes: exactly
 * `effectiveLimit` mentions are considered per run (fetched/analyzed/published-
 * or-rejected), win or lose.
 */

import {
  advanceQueryRotation,
  aggregateRecentActivity,
  getLastDailyStatusAt,
  getPendingBacklog,
  countPublished,
  getLastPublished,
  insertDiscovered,
  isKnownUrl,
  markAnalysisFailed,
  markPublishFailed,
  markPublished,
  markRejected,
  openDatabase,
  peekQueryBatch,
  recordRun,
  setLastDailyStatusAt,
  type MentionsDb,
} from "./database.js";
import { canonicalizeUrl, extractDomain, hashCanonicalUrl, UrlCanonicalizeError } from "./canonicalize.js";
import { generateFindingId, hashContent, shortHash } from "./finding.js";
import { isDomainExcluded, resolveExcludedDomains, shouldUseOpenAi, type MentionsConfig } from "./config.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { getSearchProvider } from "./search/SearchProvider.js";
import { fetchArticle } from "./content/fetchArticle.js";
import { extractContent } from "./content/extractContent.js";
import { analyzeMention } from "./ai/analyzeMention.js";
import { createTechnocoreSender, formatDailyStatusMessage, formatMessage, type SendMessageFn } from "./publisher/publishMention.js";
import { TechnocoreClient } from "../technocore.js";
import { loadIdentity, type TechnocoreIdentity } from "../identity.js";
import { fetchWithTimeout } from "./http.js";
import type { AnalysisResult, Candidate, MentionRow, RunSummary, SearchProvider } from "./types.js";
import { loadTclkConfig, type TclkConfig } from "../tclk/config.js";
import { migrateTclkTables } from "../tclk/database.js";
import { ensureTclkOffer } from "../tclk/radarOffer.js";

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
  findingId: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  snippet: string;
}

function fromRow(row: MentionRow): QueueItem {
  return {
    id: row.id,
    findingId: row.finding_id ?? generateFindingId(row.canonical_url, new Date(row.discovered_at)),
    canonicalUrl: row.canonical_url,
    title: row.title ?? "",
    domain: row.domain ?? "",
    snippet: row.snippet ?? "",
  };
}

function fromCandidate(c: Candidate): QueueItem {
  return {
    findingId: generateFindingId(c.canonicalUrl),
    canonicalUrl: c.canonicalUrl,
    title: c.title,
    domain: c.domain,
    snippet: c.snippet,
  };
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
          searchQuery: query,
          searchProvider: config.searchProvider,
        },
      });
    });
  }

  summary.new = freshlyFound.length;
  freshlyFound.sort(byDateThenPosition);

  const effectiveLimit = options.limit ?? config.maxPostsPerRun;

  // Register every new find as `discovered` immediately (real runs only), each
  // getting its permanent finding_id right then. Then pull the actual work
  // queue for THIS run from the backlog table (discovered + publish_failed,
  // oldest first), which naturally includes whatever was just inserted
  // alongside anything left over from before.
  let queue: QueueItem[];
  if (options.dryRun) {
    // No writes at all in dry-run: preview the real backlog (a read) followed by
    // this run's fresh finds (never persisted -- their finding_id is computed
    // for preview only, and would be assigned for real if this run weren't dry).
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

  // TCLK coordination is opt-in and additive: when enabled, every finding that
  // gets published below also gets a TCLK offer opened for it (radarOffer.ts).
  // Never set up (and never attempted) in dry-run, matching the rest of this
  // pipeline's dry-run contract of "no writes to Technocore or the database".
  let tclk: { config: TclkConfig; identity: TechnocoreIdentity; client: TechnocoreClient } | undefined;
  if (!options.dryRun) {
    const tclkConfig = loadTclkConfig();
    if (tclkConfig.tclkEnabled) {
      migrateTclkTables(db);
      tclk = {
        config: tclkConfig,
        identity: loadIdentity({ path: tclkConfig.identityPath }),
        client: new TechnocoreClient({ fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, tclkConfig.httpTimeoutMs) }),
      };
    }
  }

  for (const item of queue) {
    let analysis: AnalysisResult = { related: true, finding: "" };
    let contentHash: string | null = null;

    if (useOpenAi) {
      const html = await fetchArticleFn(item.canonicalUrl, { timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries });
      logEvent("fetch", { url: item.canonicalUrl, success: html !== null });
      const content = html ? extractContent(html, config.maxContentChars) : undefined;
      const hashedInput = content ?? `${item.title} ${item.snippet}`.trim();
      if (hashedInput) contentHash = hashContent(hashedInput);

      try {
        analysis = await analyze(
          { title: item.title, url: item.canonicalUrl, snippet: item.snippet, content },
          { apiKey: config.openAiApiKey!, model: config.openAiModel!, timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries },
        );
        logEvent("openai", { url: item.canonicalUrl, related: analysis.related });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        logEvent("openai", { url: item.canonicalUrl, error: message });
        if (item.id !== undefined) markAnalysisFailed(db, item.id, message);
        if (!config.publishIfAnalysisFails) {
          summary.rejected++;
          continue;
        }
        analysis = { related: true, finding: "" }; // proceed unfiltered, no finding text
      }
    }

    if (config.filterWithOpenAi && useOpenAi && !analysis.related) {
      if (item.id !== undefined) markRejected(db, item.id, "not related per OpenAI (Technocore Radar)", contentHash);
      summary.rejected++;
      continue;
    }

    const findingText = config.generateSummary ? analysis.finding : undefined;
    const contentHashShort = config.publishContentHash && contentHash ? shortHash(contentHash) : undefined;
    const messageText = formatMessage(item, findingText, contentHashShort);

    if (options.dryRun) {
      logLine("[NEW FINDING]");
      logLine("");
      logLine(`Finding: ${item.findingId}`);
      logLine(`Source: ${item.domain}`);
      logLine(`Title: ${item.title || "(untitled)"}`);
      if (findingText) {
        logLine("");
        logLine("Finding:");
        logLine(findingText);
      }
      logLine("");
      logLine("URL:");
      logLine(item.canonicalUrl);
      logLine("");
      logLine("Would publish: YES");
      logLine("");
      summary.published++;
      continue;
    }

    try {
      const posted = await sendMessage(config.technocoreRoom, messageText);
      markPublished(db, item.id!, config.technocoreRoom, String(posted.seq), findingText ?? null, contentHash);
      logEvent("publish", { finding: item.findingId, signed: true, message_id: posted.seq });
      summary.published++;

      if (tclk) {
        // Isolated failure domain, same discipline as publishRadarState below:
        // a TCLK problem must never turn an already-successful finding publish
        // into a reported failure.
        try {
          await ensureTclkOffer(db, tclk.client, tclk.config, tclk.identity, { findingId: item.findingId }, logEvent);
        } catch (err) {
          logEvent("tclk-offer", { finding: item.findingId, error: (err as Error).message ?? String(err) });
        }
      }
    } catch (err) {
      // Safe to log: TechnocoreError.message is a short "status + reason" string,
      // never headers, keys, or private key material.
      const message = (err as Error).message ?? String(err);
      markPublishFailed(db, item.id!, message, findingText ?? null, contentHash);
      logEvent("publish", { finding: item.findingId, signed: false, error: message });
    }
  }

  logEvent("summary", { ...summary });

  if (!options.dryRun) {
    recordRun(db, summary);
    if (config.publishDailyStatus) await maybePublishDailyStatus(db, config, sendMessage);
    if (config.publishRadarState) await publishRadarState(db, config);
  }

  return summary;
}

/** At most once per 24h, and only when explicitly enabled -- real, measured
 * numbers from run_log, never a per-run heartbeat. */
async function maybePublishDailyStatus(db: MentionsDb, config: MentionsConfig, sendMessage: SendMessageFn): Promise<void> {
  const lastAt = getLastDailyStatusAt(db);
  const now = new Date();
  if (lastAt && now.getTime() - new Date(lastAt).getTime() < 24 * 3600_000) return;

  const activity = aggregateRecentActivity(db, 24);
  const message = formatDailyStatusMessage(activity);
  try {
    await sendMessage(config.technocoreRoom, message);
    setLastDailyStatusAt(db, now);
    logEvent("daily-status", { published: true, ...activity });
  } catch (err) {
    logEvent("daily-status", { published: false, error: (err as Error).message ?? String(err) });
  }
}

/** Optional public evidence-of-activity note -- SQLite stays the source of
 * truth; this is a courtesy mirror, never read back by this project. */
async function publishRadarState(db: MentionsDb, config: MentionsConfig): Promise<void> {
  const lastPublished = getLastPublished(db);
  const state = {
    last_run: new Date().toISOString(),
    last_finding: lastPublished?.finding_id ?? null,
    total_findings: countPublished(db),
  };
  try {
    const client = new TechnocoreClient({
      fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs),
    });
    await client.writeNote("radar-state", config.technocoreRoom, JSON.stringify(state));
    logEvent("radar-state", { published: true, total_findings: state.total_findings });
  } catch (err) {
    logEvent("radar-state", { published: false, error: (err as Error).message ?? String(err) });
  }
}
