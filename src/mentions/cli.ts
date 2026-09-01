#!/usr/bin/env node
/**
 * Entry point for `npm run technocore:mentions`. Meant to be invoked by cron --
 * runs once and exits, never a daemon. All logic lives in run.ts; this file only
 * parses argv, loads .env/config, and picks mock vs. real search.
 */

import { loadConfig, ConfigError } from "./config.js";
import { runMentions } from "./run.js";
import { MockSearchProvider } from "./search/MockSearchProvider.js";
import { SearchProviderConfigError } from "./search/SearchProvider.js";
import { LockHeldError } from "./lock.js";
import { getFindingByFindingId, openDatabase } from "./database.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config.ts falls back to defaults / process.env as-is.
}

function parseArgs(argv: string[]): { dryRun: boolean; limit?: number; mockSearch: boolean; showFinding?: string } {
  let dryRun = false;
  let mockSearch = false;
  let limit: number | undefined;
  let showFinding: string | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--mock-search") mockSearch = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(value) || value < 0) {
        throw new ConfigError(`--limit must be a non-negative integer, got ${JSON.stringify(arg)}`);
      }
      limit = value;
    } else if (arg.startsWith("--show-finding=")) {
      showFinding = arg.slice("--show-finding=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run technocore:mentions -- [--dry-run] [--limit=N] [--mock-search] [--show-finding=<id>]\n",
      );
      process.exit(0);
    } else {
      throw new ConfigError(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, limit, mockSearch, showFinding };
}

/** Bot B's (or a human's) entry point: no HTTP API needed, just a read against
 * the same SQLite file this pipeline already writes to. Pure read -- never
 * touches Technocore, OpenAI, or the search providers. */
function showFindingCommand(config: ReturnType<typeof loadConfig>, findingId: string): void {
  const db = openDatabase(config.dbPath);
  const row = getFindingByFindingId(db, findingId);
  db.close();

  if (!row) {
    process.stderr.write(`no finding with id ${JSON.stringify(findingId)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    JSON.stringify(
      {
        finding_id: row.finding_id,
        url: row.canonical_url,
        title: row.title,
        finding: row.finding,
        checked_at: row.checked_at,
        content_hash: row.content_hash,
        status: row.status,
        technocore_room: row.technocore_room,
        technocore_message_id: row.technocore_message_id,
      },
      null,
      2,
    ) + "\n",
  );
}

async function main(): Promise<void> {
  const { dryRun, limit, mockSearch, showFinding } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (showFinding) {
    showFindingCommand(config, showFinding);
    return;
  }

  await runMentions(config, { dryRun, limit }, mockSearch ? { searchProvider: new MockSearchProvider() } : {});
}

main().catch((err) => {
  if (err instanceof ConfigError || err instanceof SearchProviderConfigError || err instanceof LockHeldError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
