#!/usr/bin/env node
/**
 * `npm run tclk:status` -- print a health/status snapshot of the TCLK
 * Marketplace Worker's local state. Pure read, no network calls, safe to run
 * anytime (including while the worker itself is running -- see status.ts).
 */

import { loadIdentity } from "../identity.js";
import { loadTclkMarketConfig, TclkMarketConfigError } from "./config.js";
import { openTclkMarketDatabase } from "./database.js";
import { computeStatus, formatStatus } from "./status.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine.
}

function main(): void {
  const config = loadTclkMarketConfig();
  const identity = loadIdentity({ path: config.identityPath });
  const db = openTclkMarketDatabase(config.dbPath);
  try {
    const status = computeStatus(db, config, identity);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatStatus(status));
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  if (err instanceof TclkMarketConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
}
