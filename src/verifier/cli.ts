#!/usr/bin/env node
/**
 * Entry point for `npm run technocore:verify`. Meant to be invoked by cron --
 * runs once and exits, never a daemon. All logic lives in run.ts; this file
 * only parses argv, loads config/identities, and picks mock vs. real sending.
 *
 * SAFETY: `loadVerifierIdentities` (identity.ts) is called unconditionally,
 * before anything else -- including --dry-run and --mock runs. If Radar's and
 * the Verifier's identity files ever resolve to the same DID, this aborts
 * immediately and nothing is published, dry-run or not.
 */

import { acquireLock, LockHeldError } from "../mentions/lock.js";
import { loadVerifierConfig, VerifierConfigError } from "./config.js";
import { loadVerifierIdentities, SameDidError } from "./identity.js";
import { openDatabase } from "./database.js";
import { runVerifier } from "./run.js";
import { createTechnocoreVerifierSender, type SendVerificationFn } from "./publisher.js";
import type { FetchArticleClassifiedResult } from "../mentions/content/fetchArticle.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config.ts falls back to defaults / process.env as-is.
}

interface ParsedArgs {
  dryRun: boolean;
  findingId?: string;
  force: boolean;
  mock: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let findingId: string | undefined;
  let force = false;
  let mock = false;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--mock") mock = true;
    else if (arg.startsWith("--finding=")) findingId = arg.slice("--finding=".length);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run technocore:verify -- [--dry-run] [--finding=<id>] [--force] [--mock]\n");
      process.exit(0);
    } else {
      throw new VerifierConfigError(`unknown argument: ${arg}`);
    }
  }

  if (force && !findingId) {
    throw new VerifierConfigError("--force only makes sense together with --finding=<id> (re-verifying a whole batch is not supported)");
  }

  return { dryRun, findingId, force, mock };
}

function logEvent(tag: string, fields: Record<string, unknown>): void {
  const lines = [`[${tag}]`, ...Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" && v.includes("\n") ? JSON.stringify(v) : v}`)];
  console.log(lines.join("\n"));
}

/** A fake in-memory sender for --mock: never touches the network, always
 * "succeeds" with a made-up sequence number. Only meaningful combined with
 * --dry-run in application code paths, but --mock alone is still safe here
 * specifically because it replaces the sender itself -- nothing this function
 * does can reach the real Technocore server. */
function createMockSender(): SendVerificationFn {
  let seq = 1;
  return async (room, text) => {
    logEvent("mock-send", { room, text });
    return { seq: seq++ };
  };
}

/** --mock's fetch/OpenAI stand-ins: fixed, in-memory content and a
 * deterministic verdict. As documented ("--mock: full pipeline test, zero
 * real Tavily/OpenAI/Technocore"), --mock replaces all three network-facing
 * dependencies, not just the Technocore sender. */
function mockFetchArticle(): Promise<FetchArticleClassifiedResult> {
  return Promise.resolve({
    kind: "ok",
    html: "<html><body>Mock article content: autonomous agents coordinate over the Technocore protocol.</body></html>",
  });
}

function mockAnalyze(): Promise<{ result: "VERIFIED"; reason: string }> {
  return Promise.resolve({ result: "VERIFIED", reason: "Mock analysis: the mock content supports the finding." });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadVerifierConfig();

  if (!config.verifierEnabled) {
    logEvent("disabled", { reason: "VERIFIER_ENABLED=false" });
    return;
  }

  // Unconditional, before any lock/db/network work: the same-DID check must
  // gate every code path, including --dry-run and --mock.
  const identities = loadVerifierIdentities(config);
  logEvent("identities", { radar_did: identities.radarDid, verifier_did: identities.verifier.did });

  const release = acquireLock(config.lockPath);
  try {
    const db = openDatabase(config.dbPath);
    try {
      const send = args.mock ? createMockSender() : createTechnocoreVerifierSender(identities.verifier, config.httpTimeoutMs);

      const summary = await runVerifier({
        config,
        db,
        identities,
        send,
        dryRun: args.dryRun,
        onlyFindingId: args.findingId,
        force: args.force,
        maxContentChars: config.maxContentChars,
        log: logEvent,
        ...(args.mock ? { fetchArticleFn: mockFetchArticle, analyzeFn: mockAnalyze } : {}),
      });

      logEvent("summary", { ...summary });
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  if (err instanceof VerifierConfigError || err instanceof LockHeldError) {
    process.stderr.write(`${err.message}\n`);
  } else if (err instanceof SameDidError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
