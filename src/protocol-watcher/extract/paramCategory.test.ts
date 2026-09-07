import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyParamName } from "./paramCategory.js";

test("paramCategory: agent_ prefix -> agent", () => {
  assert.equal(classifyParamName("agent_share_ppt"), "agent");
  assert.equal(classifyParamName("agent_daily_cap_autonomous"), "agent");
});

test("paramCategory: validator_/miner_ prefixes -> validator", () => {
  assert.equal(classifyParamName("validator_min_stake"), "validator");
  assert.equal(classifyParamName("validator_unbonding_blocks"), "validator");
  assert.equal(classifyParamName("miner_unbonding_blocks"), "validator");
  assert.equal(classifyParamName("finality_committee_size"), "validator");
});

test("paramCategory: verification-related prefixes -> verification", () => {
  assert.equal(classifyParamName("slash_fraud_percent"), "verification");
  assert.equal(classifyParamName("channel_challenger_bond"), "verification");
  assert.equal(classifyParamName("toploc_band_tau_accept_bf16_milli"), "verification");
  assert.equal(classifyParamName("sampled_audit_alpha_ppm"), "verification");
});

test("paramCategory: genesis/airdrop/emission prefixes -> tokenomics", () => {
  assert.equal(classifyParamName("genesis_supply"), "tokenomics");
  assert.equal(classifyParamName("genesis_agent_airdrop"), "tokenomics"); // agent_airdrop, but genesis_ wins as it's checked... see priority note
  assert.equal(classifyParamName("airdrop_vesting_duration_blocks"), "tokenomics");
  assert.equal(classifyParamName("halving_interval_blocks"), "tokenomics");
  assert.equal(classifyParamName("staker_share_ppt"), "tokenomics");
});

test("paramCategory: unrecognized prefix -> other", () => {
  assert.equal(classifyParamName("btc_block_time_flop_blocks"), "other");
});
