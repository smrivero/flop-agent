/**
 * Orchestrates one watcher run: fetch -> normalize -> hash -> compare ->
 * parse -> diff -> classify -> persist -> (notify, wired in by later stages).
 * Every step before "notify" always runs and always persists, dry-run or
 * not -- only the actual Telegram/Technocore sends are gated by dryRun (see
 * notify/telegram.ts, notify/technocore.ts).
 *
 * One source's trouble (network, parsing, a malformed page) is caught and
 * logged right here and never stops the rest of `sources` from being
 * processed -- and never touches that source's last valid snapshot.
 */

import { collapseWhitespace } from "./normalize/text.js";
import { parseHtmlDocument } from "./normalize/html.js";
import { parseMarkdownDocument } from "./normalize/markdown.js";
import { extractByKind } from "./extract/index.js";
import { conditionalFetch, HttpStatusError, ResponseTooLargeError, TooManyRedirectsError } from "./http.js";
import { sha256Hex } from "./hash.js";
import { storeContent } from "./storage.js";
import { diffExtractions, toSnapshotEntries } from "./diff.js";
import { classifyChanges } from "./classify.js";
import { deriveEvents } from "./events.js";
import type { ProtocolWatcherConfig } from "./config.js";
import type { ProtocolSource, ExtractionItem, ProtocolChange, ProtocolEvent } from "./types.js";
import {
  type ProtocolWatcherDb,
  type ExtractionRow,
  upsertSource,
  getLatestSnapshot,
  insertSnapshot,
  touchSnapshotCache,
  insertExtractions,
  getExtractions,
  insertChange,
  insertEventIfNew,
  recordFetchAttempt,
  referencedContentHashes,
  findPrunableSnapshots,
  deleteSnapshots,
} from "./database.js";
import { sweepOrphanedContent } from "./storage.js";
import type { ProtocolWatcherLogger } from "./logger.js";
import { summarizeForSource, buildTechnocoreSummary, formatChangeMessage } from "./summary/index.js";
import { detectTeaserYellowpaperContradiction } from "./contradictions.js";
import { sendTelegramNotification, type TelegramTransport } from "./notify/telegram.js";
import { publishTechnocoreSummary, type TechnocoreSender } from "./notify/technocore.js";
import { insertNotification } from "./database.js";

const NEVER_CALLED_TELEGRAM_TRANSPORT: TelegramTransport = {
  async send() {
    throw new Error("telegram transport invoked while disabled/dry-run -- this is a bug in the notify gating");
  },
};

const NEVER_CALLED_TECHNOCORE_SENDER: TechnocoreSender = {
  async sendSignedMessage() {
    throw new Error("technocore sender invoked while disabled/dry-run -- this is a bug in the notify gating");
  },
};

export interface RunOptions {
  config: ProtocolWatcherConfig;
  db: ProtocolWatcherDb;
  sources: ProtocolSource[];
  logger: ProtocolWatcherLogger;
  dryRun: boolean;
  now?: () => Date;
  /** Defaults to a transport that throws if ever called -- callers only need
   * to supply a real one when telegramEnabled && !dryRun (see cli.ts), and
   * tests supply a mock to observe/control sends. */
  telegramTransport?: TelegramTransport;
  technocoreSender?: TechnocoreSender;
}

export type SourceRunOutcome =
  | { sourceId: string; status: "not_modified" }
  | { sourceId: string; status: "baseline_created"; snapshotId: number }
  | { sourceId: string; status: "no_change"; snapshotId: number }
  | { sourceId: string; status: "cosmetic_only"; snapshotId: number }
  | { sourceId: string; status: "changed"; snapshotId: number; changes: ProtocolChange[]; events: ProtocolEvent[] }
  | { sourceId: string; status: "error"; error: string };

export interface RunSummary {
  changeBatchId: string;
  outcomes: SourceRunOutcome[];
  retention: { snapshotsPruned: number; filesDeleted: number };
}

function extractionRowToItem(row: ExtractionRow): ExtractionItem {
  return {
    category: row.category,
    itemKey: row.item_key,
    value: JSON.parse(row.value_json),
    sourceSection: row.source_section ?? undefined,
    status: row.extraction_status,
    error: row.extraction_error ?? undefined,
  };
}

async function fetchAndParse(source: ProtocolSource, config: ProtocolWatcherConfig, etag?: string, lastModified?: string) {
  const result = await conditionalFetch(source.url, {
    etag,
    lastModified,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    maxRedirects: config.maxRedirects,
    maxResponseBytes: config.maxResponseBytes,
  });
  if (result.notModified) return { result, parsed: undefined };

  if (result.body.trim().length === 0) {
    throw new Error("empty response body");
  }

  if (source.kind === "html-flop") {
    const { root, normalizedText } = parseHtmlDocument(result.body);
    const extraction = extractByKind("html-flop", { root });
    return { result, parsed: { normalizedText, extraction } };
  }
  const doc = parseMarkdownDocument(result.body);
  const extraction = extractByKind("markdown-tclk", { markdown: doc });
  return { result, parsed: { normalizedText: doc.normalizedText, extraction } };
}

async function runOneSource(source: ProtocolSource, options: RunOptions, changeBatchId: string): Promise<SourceRunOutcome> {
  const { config, db, logger, dryRun } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = Date.now();

  upsertSource(db, source);
  const latest = getLatestSnapshot(db, source.id);

  let fetchOutcome: Awaited<ReturnType<typeof fetchAndParse>>;
  try {
    fetchOutcome = await fetchAndParse(source, config, latest?.etag ?? undefined, latest?.last_modified ?? undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFetchAttempt(db, source.id, { success: false, error: message });
    logger.log({ action: "fetch_failed", sourceId: source.id, error: message, success: false, durationMs: Date.now() - startedAt });
    return { sourceId: source.id, status: "error", error: message };
  }

  recordFetchAttempt(db, source.id, { success: true });

  if (fetchOutcome.result.notModified) {
    logger.log({ action: "not_modified", sourceId: source.id, success: true, durationMs: Date.now() - startedAt });
    return { sourceId: source.id, status: "not_modified" };
  }

  const { result, parsed } = fetchOutcome as { result: Awaited<ReturnType<typeof conditionalFetch>>; parsed: NonNullable<Awaited<ReturnType<typeof fetchAndParse>>["parsed"]> };
  const rawHash = sha256Hex(result.body);
  const normalizedHash = sha256Hex(collapseWhitespace(parsed.normalizedText));

  if (latest && latest.normalized_hash === normalizedHash) {
    // Same semantic content -- refresh the cache validators on the existing
    // snapshot so future conditional requests use the server's latest
    // etag/Last-Modified, but never create a duplicate snapshot row.
    if (result.etag !== latest.etag || result.lastModified !== latest.last_modified) {
      touchSnapshotCache(db, latest.id, result.etag, result.lastModified);
    }
    logger.log({ action: "no_change", sourceId: source.id, normalizedHash, success: true, durationMs: Date.now() - startedAt });
    return { sourceId: source.id, status: "no_change", snapshotId: latest.id };
  }

  const { metadata, items, warnings } = parsed.extraction;
  const isBaseline = latest === undefined;

  const rawContentPath = storeContent(config.contentDir, rawHash, "raw", result.body);
  const normalizedContentPath = storeContent(config.contentDir, normalizedHash, "normalized", parsed.normalizedText);

  const snapshotId = insertSnapshot(db, {
    sourceId: source.id,
    fetchedAt: now().toISOString(),
    declaredVersion: metadata.version,
    declaredUpdatedAt: metadata.updatedAt,
    httpStatus: result.status,
    etag: result.etag,
    lastModified: result.lastModified,
    rawHash,
    normalizedHash,
    rawContentPath,
    normalizedContentPath,
    parseStatus: warnings.length > 0 ? "partial" : "ok",
    parseError: warnings.length > 0 ? warnings.join("; ") : undefined,
    isBaseline,
  });
  insertExtractions(db, snapshotId, items);

  if (isBaseline) {
    logger.log({ action: "baseline_created", sourceId: source.id, currentVersion: metadata.version, normalizedHash, success: true, durationMs: Date.now() - startedAt });
    return { sourceId: source.id, status: "baseline_created", snapshotId };
  }

  const previousItems = getExtractions(db, latest.id).map(extractionRowToItem);
  const diffEntries = diffExtractions(toSnapshotEntries(previousItems), toSnapshotEntries(items));

  if (diffEntries.length === 0) {
    logger.log({
      action: "cosmetic_only",
      sourceId: source.id,
      previousVersion: latest.declared_version ?? undefined,
      currentVersion: metadata.version,
      normalizedHash,
      success: true,
      durationMs: Date.now() - startedAt,
    });
    return { sourceId: source.id, status: "cosmetic_only", snapshotId };
  }

  const changes = classifyChanges(diffEntries, {
    sourceId: source.id,
    url: source.url,
    detectedAt: now().toISOString(),
    documentVersionBefore: latest.declared_version ?? undefined,
    documentVersionAfter: metadata.version,
  });
  for (const change of changes) {
    insertChange(db, change, changeBatchId, latest.id, snapshotId);
  }

  const events = deriveEvents(changes, { sourceId: source.id, changeBatchId, snapshotId });
  const newlyEmitted: ProtocolEvent[] = [];
  for (const event of events) {
    if (insertEventIfNew(db, event)) newlyEmitted.push(event);
  }

  // -- notify: build content first, persist the outcome of every attempt
  // (dry-run included, as a preview), never gate persistence on send success.
  const summaryMeta = {
    versionBefore: latest.declared_version ?? undefined,
    versionAfter: metadata.version,
    updatedBefore: latest.declared_updated_at ?? undefined,
    updatedAfter: metadata.updatedAt,
  };
  const changeSummary = summarizeForSource(source, changes, summaryMeta);
  const contradiction = detectTeaserYellowpaperContradiction(db);
  const telegramText = formatChangeMessage(changeSummary);
  const technocoreSummary = await buildTechnocoreSummary(changeSummary, config, contradiction.contradicts ? contradiction.note : undefined);

  const telegramTransport = options.telegramTransport ?? NEVER_CALLED_TELEGRAM_TRANSPORT;
  const technocoreSender = options.technocoreSender ?? NEVER_CALLED_TECHNOCORE_SENDER;

  const telegramResult = await sendTelegramNotification(config, telegramText, telegramTransport, dryRun);
  const attemptedAt = now().toISOString();
  insertNotification(db, { changeBatchId, channel: "telegram", destination: config.telegramChatId, status: telegramResult.status, attemptedAt, error: telegramResult.error });

  const technocoreResult = await publishTechnocoreSummary(config, changes, technocoreSummary.text, technocoreSender, dryRun);
  insertNotification(db, { changeBatchId, channel: "technocore", destination: config.technocoreRoom, status: technocoreResult.status, attemptedAt, error: technocoreResult.error });

  logger.log({
    action: "change_detected",
    sourceId: source.id,
    previousVersion: latest.declared_version ?? undefined,
    currentVersion: metadata.version,
    normalizedHash,
    changeCount: changes.length,
    severity: changes.some((c) => c.severity === "action_required") ? "action_required" : changes.some((c) => c.severity === "important") ? "important" : "info",
    telegramSent: telegramResult.status === "sent",
    technocorePublished: technocoreResult.status === "sent",
    success: true,
    durationMs: Date.now() - startedAt,
  });

  return { sourceId: source.id, status: "changed", snapshotId, changes, events: newlyEmitted };
}

export async function runWatcher(options: RunOptions): Promise<RunSummary> {
  const changeBatchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outcomes: SourceRunOutcome[] = [];

  for (const source of options.sources) {
    outcomes.push(await runOneSource(source, options, changeBatchId));
  }

  const cutoff = new Date(Date.now() - options.config.retentionDays * 86_400_000).toISOString();
  const prunable = findPrunableSnapshots(options.db, cutoff);
  deleteSnapshots(options.db, prunable.map((p) => p.id));
  const sweep = sweepOrphanedContent(options.config.contentDir, referencedContentHashes(options.db), options.config.retentionDays);

  return { changeBatchId, outcomes, retention: { snapshotsPruned: prunable.length, filesDeleted: sweep.deletedPaths.length } };
}

export { HttpStatusError, ResponseTooLargeError, TooManyRedirectsError };
