#!/usr/bin/env node
/**
 * Entry point for the five `protocol:*` npm scripts. One dispatcher file
 * with subcommands (watch/status/diff/baseline), same shape as this
 * project's own `src/cli.ts`. All logic lives in run.ts/status.ts; this file
 * only parses argv, loads config/sources, and picks real vs. mock senders.
 *
 * SAFETY: the real Telegram transport / Technocore sender are constructed
 * ONLY when their channel is enabled AND this is not a dry run -- disabled
 * (the default) or --dry-run never touches Telegram or Technocore, and
 * `protocol:baseline` never notifies at all, regardless of flags.
 */

import { acquireLock, LockHeldError } from "../mentions/lock.js";
import { loadProtocolWatcherConfig, ProtocolWatcherConfigError } from "./config.js";
import { loadProtocolSources, enabledSources, ProtocolSourcesError } from "./sources.js";
import { openDatabase, getLatestSnapshot, getChangesForBatch, getSource, type ChangeRow } from "./database.js";
import { createProtocolWatcherLogger } from "./logger.js";
import { runWatcher, type RunOptions } from "./run.js";
import { buildStatusReport } from "./status.js";
import { createHttpTelegramTransport, type TelegramTransport } from "./notify/telegram.js";
import { createRealTechnocoreSender, type TechnocoreSender } from "./notify/technocore.js";
import { formatChangeMessage, formatChangeLine, type ChangeSummary } from "./summary/deterministic.js";
import type { ProtocolChange, ProtocolChangeSeverity, ProtocolSource } from "./types.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config.ts falls back to defaults / process.env as-is.
}

class CliError extends Error {}

interface ParsedArgs {
  command: string;
  dryRun: boolean;
  force: boolean;
  source?: string;
  limit: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) throw new CliError("usage: cli.ts <watch|status|diff|baseline> [--dry-run] [--force] [--source=<id>] [--limit=N]");

  let dryRun = false;
  let force = false;
  let source: string | undefined;
  let limit = 50;

  for (const arg of rest) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
    else if (arg.startsWith("--limit=")) limit = Number.parseInt(arg.slice("--limit=".length), 10);
    else throw new CliError(`unknown argument: ${arg}`);
  }

  return { command, dryRun, force, source, limit };
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function cmdWatch(args: ParsedArgs): Promise<void> {
  const config = loadProtocolWatcherConfig();
  if (!args.dryRun && !config.enabled) {
    print("[protocol-watcher] disabled (PROTOCOL_WATCHER_ENABLED=false) -- nothing to do. Use --dry-run to preview regardless.");
    return;
  }

  const allSources = loadProtocolSources(config.sourcesPath);
  const sources = enabledSources(allSources).filter((s) => !args.source || s.id === args.source);
  if (sources.length === 0) throw new CliError(`no enabled source matches ${JSON.stringify(args.source)}`);

  const release = acquireLock(config.lockPath);
  try {
    const db = openDatabase(config.dbPath);
    try {
      const logger = createProtocolWatcherLogger();
      const telegramTransport: TelegramTransport | undefined =
        config.telegramEnabled && !args.dryRun ? createHttpTelegramTransport(config.requestTimeoutMs) : undefined;
      const technocoreSender: TechnocoreSender | undefined =
        config.technocoreEnabled && !args.dryRun ? createRealTechnocoreSender({ baseUrl: process.env.TECHNOCORE_BASE_URL }) : undefined;

      const options: RunOptions = { config, db, sources, logger, dryRun: args.dryRun, telegramTransport, technocoreSender };
      const summary = await runWatcher(options);

      print(`[protocol-watcher] run complete (${args.dryRun ? "DRY RUN -- nothing was sent" : "live"}), batch ${summary.changeBatchId}`);
      for (const outcome of summary.outcomes) {
        if (outcome.status === "changed") {
          print(`  ${outcome.sourceId}: CHANGED -- ${outcome.changes.length} change(s), ${outcome.events.length} new event(s)`);
        } else if (outcome.status === "error") {
          print(`  ${outcome.sourceId}: ERROR -- ${outcome.error}`);
        } else {
          print(`  ${outcome.sourceId}: ${outcome.status}`);
        }
      }
      print(`  retention: pruned ${summary.retention.snapshotsPruned} snapshot(s), deleted ${summary.retention.filesDeleted} file(s)`);
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

const SEVERITY_ORDER: ProtocolChangeSeverity[] = ["action_required", "important", "info"];

function cmdStatus(): void {
  const config = loadProtocolWatcherConfig();
  const db = openDatabase(config.dbPath);
  try {
    const report = buildStatusReport(db);
    print("FLOP Protocol Watcher -- status\n");
    for (const s of report.sources) {
      print(`Source: ${s.name} (${s.id})`);
      print(`  URL: ${s.url}`);
      print(`  Enabled: ${s.enabled}`);
      print(`  Last fetch attempt: ${s.lastAttemptedAt ?? "(never)"}   Last success: ${s.lastSuccessAt ?? "(never)"}`);
      print(`  Consecutive errors: ${s.consecutiveErrors}${s.lastError ? ` (last: ${s.lastError})` : ""}`);
      print(`  Declared version: ${s.declaredVersion ?? "(unknown)"}   Declared updated: ${s.declaredUpdatedAt ?? "(unknown)"}`);
      print(`  Latest snapshot: ${s.lastSnapshotAt ?? "(none -- no baseline yet)"}   hash: ${s.normalizedHashShort ?? "-"}`);
      const counts = Object.entries(s.extractionCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      print(`  Extracted parameters: ${counts || "(none)"}`);
      if (s.lastChange) print(`  Last change: field=${s.lastChange.field ?? "-"} severity=${s.lastChange.severity} at ${s.lastChange.detectedAt}`);
      print("");
    }

    print("Watched open items:");
    for (const item of report.watchedOpenItems) {
      print(item.found ? `  ${item.id}: ${item.status} (${item.title}) [${item.sourceId}]` : `  ${item.id}: not present in the current snapshot`);
    }

    print("\nRecent notifications:");
    for (const n of report.recentNotifications) {
      print(`  [${n.attempted_at}] ${n.channel} -> ${n.status}${n.error ? ` (${n.error})` : ""}`);
    }
  } finally {
    db.close();
  }
}

function cmdDiff(args: ParsedArgs): void {
  const config = loadProtocolWatcherConfig();
  const db = openDatabase(config.dbPath);
  try {
    const row = db.prepare(`SELECT change_batch_id FROM protocol_changes ORDER BY id DESC LIMIT 1`).get() as { change_batch_id: string } | undefined;
    if (!row) {
      print("No changes recorded yet.");
      return;
    }

    const allChanges: ChangeRow[] = getChangesForBatch(db, row.change_batch_id).filter((c) => !args.source || c.source_id === args.source);
    if (allChanges.length === 0) {
      print(`No changes in the latest batch for source ${JSON.stringify(args.source)}.`);
      return;
    }

    const bySource = new Map<string, ChangeRow[]>();
    for (const c of allChanges) {
      if (!bySource.has(c.source_id)) bySource.set(c.source_id, []);
      bySource.get(c.source_id)!.push(c);
    }

    for (const [sourceId, changes] of bySource) {
      const sourceRow = getSource(db, sourceId);
      const source: ProtocolSource = { id: sourceId, name: sourceRow?.name ?? sourceId, url: sourceRow?.url ?? "", kind: "html-flop", enabled: true };
      const severity = SEVERITY_ORDER.find((s) => changes.some((c) => c.severity === s)) ?? "info";
      const summary: ChangeSummary = {
        sourceId,
        sourceName: source.name,
        url: source.url,
        severity,
        changeLines: changes.map((c) =>
          formatChangeLine({
            sourceId: c.source_id,
            detectedAt: c.detected_at,
            category: c.category as ProtocolChange["category"],
            itemId: c.item_id ?? undefined,
            field: c.field ?? undefined,
            previousValue: c.previous_value_json ? JSON.parse(c.previous_value_json) : undefined,
            currentValue: c.current_value_json ? JSON.parse(c.current_value_json) : undefined,
            changeType: c.change_type as ProtocolChange["changeType"],
            severity: c.severity as ProtocolChangeSeverity,
            evidence: JSON.parse(c.evidence_json),
          }),
        ),
      };
      print(formatChangeMessage(summary));
      print("");
    }
  } finally {
    db.close();
  }
}

async function cmdBaseline(args: ParsedArgs): Promise<void> {
  const config = loadProtocolWatcherConfig();
  const allSources = loadProtocolSources(config.sourcesPath);
  const candidates = enabledSources(allSources).filter((s) => !args.source || s.id === args.source);
  if (candidates.length === 0) throw new CliError(`no enabled source matches ${JSON.stringify(args.source)}`);

  const release = acquireLock(config.lockPath);
  try {
    const db = openDatabase(config.dbPath);
    try {
      const toRun = candidates.filter((s) => {
        const existing = getLatestSnapshot(db, s.id);
        if (existing && !args.force) {
          print(`[protocol-watcher] ${s.id}: a baseline already exists (from ${existing.fetched_at}) -- pass --force to proceed anyway.`);
          return false;
        }
        return true;
      });
      if (toRun.length === 0) {
        print("[protocol-watcher] nothing to baseline.");
        return;
      }

      const logger = createProtocolWatcherLogger();
      // Baseline never notifies, regardless of --force -- dryRun:true guarantees that
      // even when re-baselining a source that already has one (and might otherwise diff).
      const summary = await runWatcher({ config, db, sources: toRun, logger, dryRun: true });
      for (const outcome of summary.outcomes) {
        print(`[protocol-watcher] ${outcome.sourceId}: ${outcome.status}`);
      }
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "watch") return cmdWatch(args);
  if (args.command === "status") return cmdStatus();
  if (args.command === "diff") return cmdDiff(args);
  if (args.command === "baseline") return cmdBaseline(args);
  throw new CliError(`unknown command: ${args.command}`);
}

main().catch((err) => {
  if (err instanceof CliError || err instanceof ProtocolWatcherConfigError || err instanceof ProtocolSourcesError || err instanceof LockHeldError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
