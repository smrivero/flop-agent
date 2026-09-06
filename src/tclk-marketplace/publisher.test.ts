import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOwnOffer } from "./publisher.js";
import type { TclkMarketConfig } from "./config.js";
import { makeTestIdentity } from "../tclk/testUtils.js";

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "tclk-publisher-test-")), name);
}

function baseConfig(overrides: Partial<TclkMarketConfig> = {}): TclkMarketConfig {
  return {
    enabled: true,
    dryRun: false,
    identityPath: ".technocore/identity.json",
    offerRoom: "tclk-offers",
    rail: "paper",
    dbPath: "",
    secretsPath: "",
    lockPath: "/dev/null",
    autoAccept: true,
    maxConcurrentDeals: 2,
    minAmount: 0n,
    maxJobDurationMs: 900_000,
    allowedAssets: ["PAPER"],
    allowedRails: ["paper"],
    supportedJobTypes: ["echo"],
    allowedCounterpartyDids: [],
    autoPublish: false,
    maxOpenOffers: 3,
    minOfferIntervalMs: 3_600_000,
    offerAmount: "1000000",
    offerAsset: "PAPER",
    offerJobType: "echo",
    offerJobContextPoolPath: "/dev/null/does-not-exist",
    offerExpiresMinutes: 30,
    claimMinutes: 1,
    refundMinutes: 2,
    pollIntervalMs: 15_000,
    longPollWaitSeconds: 0,
    maxBackoffMs: 30_000,
    httpTimeoutMs: 15_000,
    maxRetries: 0,
    logLevel: "info",
    ...overrides,
  };
}

test("buildOwnOffer: an explicit jobContext is used verbatim, the pool is never consulted", () => {
  const identity = makeTestIdentity();
  const config = baseConfig({ offerJobContextPoolPath: "/dev/null/does-not-exist" });
  const offer = buildOwnOffer(config, identity, { jobContext: "explicit context wins" });
  assert.equal(offer.job?.context, "explicit context wins");
});

test("buildOwnOffer: no jobContext given and no pool file -- job.context stays undefined, same as before the pool existed", () => {
  const identity = makeTestIdentity();
  const config = baseConfig({ offerJobContextPoolPath: "/dev/null/does-not-exist" });
  const offer = buildOwnOffer(config, identity, {});
  assert.equal(offer.job?.context, undefined);
});

test("buildOwnOffer: no jobContext given and a pool file exists -- one of its lines is used", () => {
  const identity = makeTestIdentity();
  const poolPath = tempPath("pool.txt");
  writeFileSync(poolPath, "line one\nline two\nline three\n");
  const config = baseConfig({ offerJobContextPoolPath: poolPath });

  const seen = new Set<string | undefined>();
  for (let i = 0; i < 20; i++) {
    const offer = buildOwnOffer(config, identity, {});
    assert.ok(offer.job?.context !== undefined);
    assert.ok(["line one", "line two", "line three"].includes(offer.job!.context!));
    seen.add(offer.job?.context);
  }
  // Not a strict requirement of randomness, but with 20 draws from 3 lines
  // this would only fail to show variety by extraordinary bad luck --
  // mainly guards against a copy-paste bug that always returns lines[0].
  assert.ok(seen.size > 1, `expected more than one distinct context across 20 draws, got ${JSON.stringify([...seen])}`);
});

test("buildOwnOffer: blank lines in the pool file are ignored", () => {
  const identity = makeTestIdentity();
  const poolPath = tempPath("pool-with-blanks.txt");
  writeFileSync(poolPath, "\n\nonly real line\n\n");
  const config = baseConfig({ offerJobContextPoolPath: poolPath });

  const offer = buildOwnOffer(config, identity, {});
  assert.equal(offer.job?.context, "only real line");
});
