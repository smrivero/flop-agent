#!/usr/bin/env node
/**
 * `npm run tclk:offer -- [--amount N] [--asset SYM] [--job type] [--job-id id]`
 * Publish one TCLK offer by hand, as PAYER, to the public tclk-offers room.
 * Independent of the worker loop (cli.ts) -- useful for the smoke test and
 * for a human operator who wants to post a one-off offer without enabling
 * the full auto-publish policy.
 *
 * Respects TCLK_MKT_DRY_RUN / --dry-run: prints what would be posted without
 * sending anything.
 */

import { loadIdentity } from "../identity.js";
import { fetchWithTimeout } from "../mentions/http.js";
import { TechnocoreClient } from "../technocore.js";
import { loadTclkMarketConfig, TclkMarketConfigError } from "./config.js";
import { openTclkMarketDatabase } from "./database.js";
import { createLogger } from "./logger.js";
import { buildOwnOffer, publishOffer } from "./publisher.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine.
}

function parseArgs(argv: string[]): { amount?: string; asset?: string; job?: string; jobId?: string; jobContext?: string; dryRun: boolean } {
  const out: ReturnType<typeof parseArgs> = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run tclk:offer -- [--amount N] [--asset SYM] [--job type] [--job-id id] [--job-context ctx] [--dry-run]\n",
      );
      process.exit(0);
    }
    const value = argv[++i];
    if (value === undefined) throw new TclkMarketConfigError(`missing value for ${arg}`);
    if (arg === "--amount") out.amount = value;
    else if (arg === "--asset") out.asset = value;
    else if (arg === "--job") out.job = value;
    else if (arg === "--job-id") out.jobId = value;
    else if (arg === "--job-context") out.jobContext = value;
    else throw new TclkMarketConfigError(`unknown argument: ${arg}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadTclkMarketConfig();
  if (args.dryRun) config.dryRun = true;

  const log = createLogger(config.logLevel);
  const identity = loadIdentity({ path: config.identityPath });
  const db = openTclkMarketDatabase(config.dbPath);
  try {
    const client = new TechnocoreClient({ fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs) });

    if (config.dryRun) {
      const offer = buildOwnOffer(config, identity, { amount: args.amount, asset: args.asset, jobType: args.job, jobId: args.jobId, jobContext: args.jobContext });
      log.info("[PUBLISHER][DRY_RUN]", { would_post: true, room: config.offerRoom, offer_id: offer.id, amount: offer.amount, asset: offer.asset, job: offer.job?.proto });
      return;
    }

    const { offer, messageId } = await publishOffer(
      db,
      client,
      config,
      identity,
      { amount: args.amount, asset: args.asset, jobType: args.job, jobId: args.jobId, jobContext: args.jobContext },
      log,
    );
    console.log(`Published offer ${offer.id} to ${config.offerRoom} (seq ${messageId})`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  if (err instanceof TclkMarketConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
