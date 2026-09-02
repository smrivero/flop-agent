#!/usr/bin/env node
/**
 * `npm run technocore:tclk-market` -- the TCLK Marketplace Worker. A
 * long-running service by default (its own process, own event loop, no
 * cron), the same "own loop/task" isolation debate/cli.ts uses: one bad tick
 * is caught and logged, never fatal, and this process crashing or being
 * stopped has zero effect on radar/mentions/debate, which are entirely
 * separate processes/cron jobs that never import this module.
 *
 * `--once` runs a single tick and exits (cron-friendly alternative, same
 * shape as technocore:tclk-payer/-verifier). `--dry-run` forces
 * TCLK_MKT_DRY_RUN=true regardless of the .env value, for a safe rehearsal.
 */

import { acquireLock, LockHeldError } from "../mentions/lock.js";
import { fetchWithTimeout } from "../mentions/http.js";
import { loadIdentity } from "../identity.js";
import { TechnocoreClient } from "../technocore.js";
import { loadTclkMarketConfig, TclkMarketConfigError } from "./config.js";
import { openTclkMarketDatabase } from "./database.js";
import { openSecretStore } from "../tclk/secretStore.js";
import { createLogger } from "./logger.js";
import { computeStatus, formatStatus } from "./status.js";
import { runTclkMarketTick } from "./worker.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config falls back to defaults / process.env as-is.
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

function parseArgs(argv: string[]): { once: boolean; dryRun: boolean } {
  let once = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--once") once = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run technocore:tclk-market -- [--once] [--dry-run]\n");
      process.exit(0);
    } else {
      throw new TclkMarketConfigError(`unknown argument: ${arg}`);
    }
  }
  return { once, dryRun };
}

const BACKOFF_SCHEDULE_MS = [1000, 2000, 5000, 10000, 30000];

async function main(): Promise<void> {
  const { once, dryRun: forceDryRun } = parseArgs(process.argv.slice(2));
  const config = loadTclkMarketConfig();
  if (forceDryRun) config.dryRun = true;

  if (!config.enabled) {
    console.log("[TCLK][DISABLED] reason=ENABLE_TCLK=false -- radar/mentions and debate are unaffected and keep running independently");
    return;
  }

  const log = createLogger(config.logLevel);
  const identity = loadIdentity({ path: config.identityPath });
  log.info("[STARTUP]", { did: identity.did, offer_room: config.offerRoom, dry_run: config.dryRun, auto_accept: config.autoAccept, auto_publish: config.autoPublish });

  const release = acquireLock(config.lockPath);
  const controller = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("[SHUTDOWN]", { signal });
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    const db = openTclkMarketDatabase(config.dbPath);
    const secretDb = openSecretStore(config.secretsPath);
    try {
      const client = new TechnocoreClient({
        fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs),
      });

      if (once) {
        const summary = await runTclkMarketTick({ db, secretDb, client, config, identity, log });
        log.info("[TICK][SUMMARY]", { ...summary });
        log.info("[STATUS]", { ...computeStatus(db, config, identity) });
        return;
      }

      let backoffIndex = -1; // -1 = no error yet, use the normal poll interval
      while (!controller.signal.aborted) {
        try {
          const summary = await runTclkMarketTick({ db, secretDb, client, config, identity, log });
          log.info("[TICK][SUMMARY]", { ...summary });
          backoffIndex = -1;
        } catch (err) {
          // A tick-level failure here means something outside the per-item
          // try/catch already inside runTclkMarketTick threw (e.g. the
          // initial room read itself). Never fatal: log, back off, retry.
          backoffIndex = Math.min(backoffIndex + 1, BACKOFF_SCHEDULE_MS.length - 1);
          const delay = Math.min(BACKOFF_SCHEDULE_MS[backoffIndex], config.maxBackoffMs);
          log.info("[ERROR]", { stage: "tick", error: err instanceof Error ? err.message : String(err), backoff_ms: delay });
          await sleep(delay, controller.signal);
          continue;
        }
        await sleep(config.pollIntervalMs, controller.signal);
      }
      log.info("[STOPPED]", {});
    } finally {
      db.close();
      secretDb.close();
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  if (err instanceof TclkMarketConfigError || err instanceof LockHeldError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
