import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOffer } from "@flop-labs/tclk";
import { loadTclkMarketConfig } from "./config.js";
import { shouldAcceptOffer } from "./policy.js";

function baseConfig(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return loadTclkMarketConfig({
    ENABLE_TCLK: "true",
    TCLK_MKT_AUTO_ACCEPT: "true",
    TCLK_MKT_ALLOWED_RAILS: "paper",
    TCLK_MKT_ALLOWED_ASSETS: "PAPER",
    TCLK_MKT_SUPPORTED_JOB_TYPES: "echo",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function baseOffer(overrides: Partial<Parameters<typeof makeOffer>[0]> = {}) {
  const now = Date.now();
  return makeOffer({
    from: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    role: "payer",
    lock: "hash",
    amount: "1000000",
    asset: "PAPER",
    rails: ["paper"],
    claimByMs: now + 60_000,
    refundAfterMs: now + 120_000,
    expiresMs: now + 30_000,
    job: { proto: "echo", id: "job-1" },
    ...overrides,
  });
}

test("policy: accepts a well-formed, in-policy offer", () => {
  const config = baseConfig();
  const offer = baseOffer();
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "ACCEPT");
});

test("policy: rejects an expired offer", () => {
  const config = baseConfig();
  const offer = baseOffer({ expiresMs: Date.now() - 1000 });
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "offer_expired");
});

test("policy: rejects an unsupported rail", () => {
  const config = baseConfig({ TCLK_MKT_ALLOWED_RAILS: "flop-htlc" });
  const offer = baseOffer();
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "unsupported_rail");
});

test("policy: rejects an unsupported asset", () => {
  const config = baseConfig({ TCLK_MKT_ALLOWED_ASSETS: "FLOP" });
  const offer = baseOffer({ asset: "PAPER" });
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "unsupported_asset");
});

test("policy: rejects an unsupported job type", () => {
  const config = baseConfig({ TCLK_MKT_SUPPORTED_JOB_TYPES: "verification-test" });
  const offer = baseOffer({ job: { proto: "run-arbitrary-shell", id: "x" } });
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "unsupported_job_type");
});

test("policy: rejects an amount below the configured minimum", () => {
  const config = baseConfig({ TCLK_MKT_MIN_AMOUNT: "500" });
  const offer = baseOffer({ amount: "100" });
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "amount_below_minimum");
});

test("policy: rejects when the concurrent-deal cap is reached", () => {
  const config = baseConfig({ TCLK_MKT_MAX_CONCURRENT_DEALS: "1" });
  const offer = baseOffer();
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 1, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "max_concurrent_deals_reached");
});

test("policy: ignores an offer already processed (idempotency)", () => {
  const config = baseConfig();
  const offer = baseOffer();
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: true });
  assert.equal(result.decision, "IGNORE");
  assert.equal(result.reason, "already_processed");
});

test("policy: ignores a payee-role offer (not a shape this worker automates yet)", () => {
  const config = baseConfig();
  const offer = baseOffer({ role: "payee" });
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "IGNORE");
  assert.equal(result.reason, "unsupported_role");
});

test("policy: rejects when auto-accept is disabled, even for an otherwise-valid offer", () => {
  const config = baseConfig({ TCLK_MKT_AUTO_ACCEPT: "false" });
  const offer = baseOffer();
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "auto_accept_disabled");
});

test("policy: rejects a job whose claim window exceeds TCLK_MKT_MAX_JOB_DURATION_MS", () => {
  const config = baseConfig({ TCLK_MKT_MAX_JOB_DURATION_MS: "1000" });
  const offer = baseOffer({ claimByMs: Date.now() + 60_000, refundAfterMs: Date.now() + 120_000 });
  const result = shouldAcceptOffer(offer, config, { now: Date.now(), activePayeeDeals: 0, alreadyDecided: false });
  assert.equal(result.decision, "REJECT");
  assert.equal(result.reason, "job_duration_too_long");
});
