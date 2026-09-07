/**
 * Deterministic name -> category classifier for Appendix A ("Parameter
 * Reference") rows. Plain data + prefix checks, evaluated in a fixed
 * priority order -- not a semantic reading of every one of the ~150
 * parameters, but reproducible and easy to extend when a new prefix shows
 * up. Every parameter is still persisted in full regardless of which bucket
 * it lands in (see extract/params.ts) -- this only decides `category` for
 * ProtocolChange / status grouping.
 */

import type { ExtractionCategory } from "../types.js";

const AGENT_PREFIXES = ["agent_"];

const VALIDATOR_PREFIXES = ["validator_", "validators_", "miner_", "min_miner_"];
const VALIDATOR_EXACT = new Set(["finality_committee_size", "max_delegators_per_miner"]);

const VERIFICATION_PREFIXES = [
  "slash_",
  "channel_",
  "audit_",
  "toploc_",
  "attest_",
  "da_",
  "finality_",
  "poui_",
  "calibration_",
  "metering_",
  "sampled_audit",
  "soft_tier",
  "timing_",
  "security_kappa",
];

const TOKENOMICS_PREFIXES = [
  "genesis_",
  "airdrop_",
  "halving_",
  "emission_",
  "floor_",
  "subsidy_",
  "governor_",
  "governance_",
  "protocol_upgrade_",
  "fip_",
  "circuit_breaker",
  "tx_",
];

function matchesAny(name: string, prefixes: string[]): boolean {
  return prefixes.some((p) => name.startsWith(p));
}

export function classifyParamName(name: string): ExtractionCategory {
  const lower = name.toLowerCase();
  if (matchesAny(lower, AGENT_PREFIXES)) return "agent";
  if (matchesAny(lower, VALIDATOR_PREFIXES) || VALIDATOR_EXACT.has(lower)) return "validator";
  if (matchesAny(lower, VERIFICATION_PREFIXES)) return "verification";
  if (matchesAny(lower, TOKENOMICS_PREFIXES) || lower.endsWith("_share_ppt")) return "tokenomics";
  return "other";
}
