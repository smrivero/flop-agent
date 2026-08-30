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

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config.ts falls back to defaults / process.env as-is.
}

function parseArgs(argv: string[]): { dryRun: boolean; limit?: number; mockSearch: boolean } {
  let dryRun = false;
  let mockSearch = false;
  let limit: number | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--mock-search") mockSearch = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(value) || value < 0) {
        throw new ConfigError(`--limit must be a non-negative integer, got ${JSON.stringify(arg)}`);
      }
      limit = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run technocore:mentions -- [--dry-run] [--limit=N] [--mock-search]\n",
      );
      process.exit(0);
    } else {
      throw new ConfigError(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, limit, mockSearch };
}

async function main(): Promise<void> {
  const { dryRun, limit, mockSearch } = parseArgs(process.argv.slice(2));
  const config = loadConfig();

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
