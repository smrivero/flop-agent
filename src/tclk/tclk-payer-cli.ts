#!/usr/bin/env node
/**
 * Entry point for `npm run technocore:tclk-payer`. Meant to be invoked by
 * cron -- runs once and exits, never a daemon: read current state, perform
 * whatever transitions are currently valid, exit. Agent A's identity
 * (.technocore/identity.json / TECHNOCORE_IDENTITY_PATH) signs everything
 * this process posts.
 */

import { acquireLock, LockHeldError } from "../mentions/lock.js";
import { fetchWithTimeout } from "../mentions/http.js";
import { loadIdentity } from "../identity.js";
import { TechnocoreClient } from "../technocore.js";
import { loadTclkConfig, TclkConfigError } from "./config.js";
import { openTclkDatabase } from "./database.js";
import { runTclkPayer } from "./payer.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config falls back to defaults / process.env as-is.
}

function logEvent(tag: string, fields: Record<string, unknown>): void {
  const lines = [`[${tag}]`, ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`)];
  console.log(lines.join("\n"));
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run technocore:tclk-payer -- [--dry-run]\n");
      process.exit(0);
    } else {
      throw new TclkConfigError(`unknown argument: ${arg}`);
    }
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const config = loadTclkConfig();

  if (!config.tclkEnabled) {
    logEvent("disabled", { reason: "TCLK_ENABLED=false" });
    return;
  }

  const identity = loadIdentity({ path: config.identityPath });
  logEvent("identity", { role: "payer", did: identity.did });

  const release = acquireLock(config.payerLockPath);
  try {
    const db = openTclkDatabase(config.dbPath);
    try {
      const client = new TechnocoreClient({
        fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs),
      });

      const summary = await runTclkPayer({ db, client, config, identity, dryRun, log: logEvent });

      for (const c of summary.contracts) {
        logEvent("contract", {
          finding: c.findingId,
          contract: c.contractId,
          status: c.status,
          next_action: c.action.kind,
          reason: "reason" in c.action ? c.action.reason : undefined,
          posted: c.posted ? `${c.posted.kind}#${c.posted.messageId}` : undefined,
        });
      }
      logEvent("summary", { contracts: summary.contracts.length, dry_run: dryRun });
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  if (err instanceof TclkConfigError || err instanceof LockHeldError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
