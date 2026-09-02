#!/usr/bin/env node
/**
 * Entry point for `npm run technocore:tclk-verifier`. Meant to be invoked by
 * cron -- runs once and exits, never a daemon. Agent B's identity
 * (VERIFIER_IDENTITY_PATH, default .technocore/identityB.json) signs
 * everything this process posts; independent verification reuses
 * verifier/openai.ts (VERIFIER_MODEL / OPENAI_API_KEY) exactly as the plain
 * Verifier pipeline does.
 *
 * SAFETY: cross-checks Radar's and Agent B's DIDs before anything else --
 * same discipline as verifier/cli.ts, and for the same reason: if they ever
 * resolve to the same key, this agent would be "independently" verifying its
 * own offers.
 */

import { acquireLock, LockHeldError } from "../mentions/lock.js";
import { fetchWithTimeout } from "../mentions/http.js";
import { loadIdentity } from "../identity.js";
import { TechnocoreClient } from "../technocore.js";
import { assertDistinctPayerAndVerifierDids, loadTclkConfig, TclkConfigError, TclkSameDidError } from "./config.js";
import { openTclkDatabase } from "./database.js";
import { openSecretStore } from "./secretStore.js";
import { runTclkVerifier } from "./verifierWorker.js";

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
      process.stdout.write("Usage: npm run technocore:tclk-verifier -- [--dry-run]\n");
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

  const openAiApiKey = process.env.OPENAI_API_KEY;
  const verifierModel = process.env.VERIFIER_MODEL?.trim() || process.env.OPENAI_MODEL?.trim();
  if (!openAiApiKey) throw new TclkConfigError("OPENAI_API_KEY is required to run technocore:tclk-verifier");
  if (!verifierModel) throw new TclkConfigError("VERIFIER_MODEL (or OPENAI_MODEL as a fallback) is required to run technocore:tclk-verifier");

  const radarDid = loadIdentity({ path: config.identityPath }).did;
  const identity = loadIdentity({ path: config.verifierIdentityPath });
  assertDistinctPayerAndVerifierDids(radarDid, identity.did, config.identityPath, config.verifierIdentityPath);
  logEvent("identity", { role: "payee", did: identity.did, allowed_payer_did: config.allowedPayerDid });

  const release = acquireLock(config.verifierLockPath);
  try {
    const db = openTclkDatabase(config.dbPath);
    const secretDb = openSecretStore(config.secretsPath);
    try {
      const client = new TechnocoreClient({
        fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs),
      });

      const summary = await runTclkVerifier({
        db,
        secretDb,
        client,
        config,
        identity,
        openAiApiKey,
        verifierModel,
        dryRun,
        log: logEvent,
      });

      for (const c of summary.contracts) {
        logEvent("contract", {
          finding: c.findingId,
          contract: c.contractId,
          status: c.status,
          next_action: c.action.kind,
          reason: "reason" in c.action ? c.action.reason : undefined,
          posted: c.posted ? `${c.posted.kind}#${c.posted.messageId}` : undefined,
          error: c.error,
        });
      }
      logEvent("summary", {
        contracts: summary.contracts.length,
        accepted: summary.acceptedCount,
        failed: summary.contracts.filter((c) => c.error).length,
        dry_run: dryRun,
      });
    } finally {
      secretDb.close();
      db.close();
    }
  } finally {
    release();
  }
}

main().catch((err) => {
  if (err instanceof TclkConfigError || err instanceof LockHeldError || err instanceof TclkSameDidError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
