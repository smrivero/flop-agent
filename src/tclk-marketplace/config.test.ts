import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTclkMarketConfig, TclkMarketConfigError } from "./config.js";

test("config: disabled by default (ENABLE_TCLK unset)", () => {
  const config = loadTclkMarketConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.equal(config.autoAccept, false); // no auto-accept indiscriminado, by default
  assert.equal(config.offerRoom, "tclk-offers"); // the official public rendezvous room
});

test("config: ENABLE_TCLK is independent of the other TCLK_* namespace (TCLK_ENABLED)", () => {
  const config = loadTclkMarketConfig({ ENABLE_TCLK: "true", TCLK_ENABLED: "false" } as NodeJS.ProcessEnv);
  assert.equal(config.enabled, true);
});

test("config: rejects claimMinutes >= refundMinutes", () => {
  assert.throws(
    () => loadTclkMarketConfig({ ENABLE_TCLK: "true", TCLK_MKT_CLAIM_MINUTES: "10", TCLK_MKT_REFUND_MINUTES: "10" } as NodeJS.ProcessEnv),
    TclkMarketConfigError,
  );
});

test("config: rejects a non-paper rail", () => {
  assert.throws(() => loadTclkMarketConfig({ TCLK_MKT_RAIL: "flop-htlc" } as NodeJS.ProcessEnv), TclkMarketConfigError);
});

test("config: rejects a long-poll wait over 10 seconds", () => {
  assert.throws(() => loadTclkMarketConfig({ TCLK_MKT_LONG_POLL_WAIT_SECONDS: "11" } as NodeJS.ProcessEnv), TclkMarketConfigError);
});

test("config: parses comma-separated lists", () => {
  const config = loadTclkMarketConfig({ TCLK_MKT_ALLOWED_ASSETS: "PAPER, FLOP", TCLK_MKT_SUPPORTED_JOB_TYPES: "echo,research-test" } as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedAssets, ["PAPER", "FLOP"]);
  assert.deepEqual(config.supportedJobTypes, ["echo", "research-test"]);
});
