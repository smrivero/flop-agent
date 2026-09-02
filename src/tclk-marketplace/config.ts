/**
 * Config for the TCLK Marketplace Worker -- a THIRD, independent flow, separate
 * from src/tclk/ (Radar<->Verifier's own private, single-payer negotiation) and
 * from mentions/ (radar) and debate/. Every env var here is its own namespace
 * (`TCLK_MKT_*` / `ENABLE_TCLK`) specifically so toggling this worker never
 * touches `TCLK_ENABLED`, `TCLK_RAIL`, `TCLK_AMOUNT`, etc, which already mean
 * something else for that other flow. See README "TCLK Marketplace Worker".
 *
 * Reuses TECHNOCORE_URL / HTTP_TIMEOUT_MS / MAX_RETRIES / LOG_LEVEL from the
 * rest of the project where it makes sense -- nothing here duplicates those.
 */

import { OFFER_ROOM } from "@flop-labs/tclk";

export class TclkMarketConfigError extends Error {}

export type TclkMarketRail = "paper";

export interface TclkMarketConfig {
  enabled: boolean;
  dryRun: boolean;

  identityPath: string;
  offerRoom: string;
  rail: TclkMarketRail;

  dbPath: string;
  secretsPath: string;
  lockPath: string;

  // -- policy ---------------------------------------------------------------
  autoAccept: boolean;
  maxConcurrentDeals: number;
  minAmount: bigint;
  maxJobDurationMs: number;
  allowedAssets: string[];
  allowedRails: string[];
  supportedJobTypes: string[];
  /** Empty = accept from any counterparty DID (this is a public marketplace). */
  allowedCounterpartyDids: string[];

  // -- our own offers ---------------------------------------------------------
  autoPublish: boolean;
  maxOpenOffers: number;
  minOfferIntervalMs: number;
  offerAmount: string;
  offerAsset: string;
  offerJobType: string;
  offerExpiresMinutes: number;
  claimMinutes: number;
  refundMinutes: number;

  // -- polling / rate limiting -------------------------------------------------
  pollIntervalMs: number;
  longPollWaitSeconds: number;
  maxBackoffMs: number;

  httpTimeoutMs: number;
  maxRetries: number;

  logLevel: "debug" | "info";
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseIntPositive(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new TclkMarketConfigError(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

function parseIntNonNegative(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new TclkMarketConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return n;
}

function parseList(value: string | undefined, defaultValue: string[]): string[] {
  if (value === undefined || value.trim() === "") return defaultValue;
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseBigIntNonNegative(value: string | undefined, defaultValue: string, name: string): bigint {
  const raw = value === undefined || value.trim() === "" ? defaultValue : value.trim();
  try {
    const n = BigInt(raw);
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new TclkMarketConfigError(`${name} must be a non-negative decimal integer string, got ${JSON.stringify(raw)}`);
  }
}

export function loadTclkMarketConfig(env: NodeJS.ProcessEnv = process.env): TclkMarketConfig {
  const enabled = parseBool(env.ENABLE_TCLK, false);
  const dryRun = parseBool(env.TCLK_MKT_DRY_RUN, false);

  const rail = (env.TCLK_MKT_RAIL?.trim().toLowerCase() || "paper") as TclkMarketRail;
  if (rail !== "paper") {
    throw new TclkMarketConfigError(`TCLK_MKT_RAIL must be "paper" (no other rail is wired up yet), got ${JSON.stringify(env.TCLK_MKT_RAIL)}`);
  }

  const claimMinutes = parseIntPositive(env.TCLK_MKT_CLAIM_MINUTES, 60, "TCLK_MKT_CLAIM_MINUTES");
  const refundMinutes = parseIntPositive(env.TCLK_MKT_REFUND_MINUTES, 120, "TCLK_MKT_REFUND_MINUTES");
  if (claimMinutes >= refundMinutes) {
    throw new TclkMarketConfigError("TCLK_MKT_CLAIM_MINUTES must be strictly less than TCLK_MKT_REFUND_MINUTES (tclk requires claimByMs < refundAfterMs)");
  }

  const longPollWaitSeconds = parseIntNonNegative(env.TCLK_MKT_LONG_POLL_WAIT_SECONDS, 10, "TCLK_MKT_LONG_POLL_WAIT_SECONDS");
  if (longPollWaitSeconds > 10) {
    throw new TclkMarketConfigError("TCLK_MKT_LONG_POLL_WAIT_SECONDS must be 0-10 (technocore's own long-poll cap)");
  }

  return {
    enabled,
    dryRun,

    identityPath: env.TCLK_MKT_IDENTITY_PATH?.trim() || env.TECHNOCORE_IDENTITY_PATH?.trim() || ".technocore/identity.json",
    offerRoom: env.TCLK_MKT_OFFER_ROOM?.trim() || OFFER_ROOM,
    rail,

    dbPath: env.TCLK_MKT_DB_PATH?.trim() || ".data/tclk-marketplace.sqlite3",
    secretsPath: env.TCLK_MKT_SECRETS_PATH?.trim() || ".technocore/tclk-market-secrets.sqlite3",
    lockPath: env.TCLK_MKT_LOCK_PATH?.trim() || ".data/tclk-market.lock",

    autoAccept: parseBool(env.TCLK_MKT_AUTO_ACCEPT, false),
    maxConcurrentDeals: parseIntPositive(env.TCLK_MKT_MAX_CONCURRENT_DEALS, 2, "TCLK_MKT_MAX_CONCURRENT_DEALS"),
    minAmount: parseBigIntNonNegative(env.TCLK_MKT_MIN_AMOUNT, "0", "TCLK_MKT_MIN_AMOUNT"),
    maxJobDurationMs: parseIntPositive(env.TCLK_MKT_MAX_JOB_DURATION_MS, 900_000, "TCLK_MKT_MAX_JOB_DURATION_MS"),
    allowedAssets: parseList(env.TCLK_MKT_ALLOWED_ASSETS, ["PAPER", "FLOP"]),
    allowedRails: parseList(env.TCLK_MKT_ALLOWED_RAILS, ["paper"]),
    supportedJobTypes: parseList(env.TCLK_MKT_SUPPORTED_JOB_TYPES, ["echo", "research-test", "verification-test"]),
    allowedCounterpartyDids: parseList(env.TCLK_MKT_ALLOWED_COUNTERPARTY_DIDS, []),

    autoPublish: parseBool(env.TCLK_MKT_AUTO_PUBLISH, false),
    maxOpenOffers: parseIntPositive(env.TCLK_MKT_MAX_OPEN_OFFERS, 3, "TCLK_MKT_MAX_OPEN_OFFERS"),
    minOfferIntervalMs: parseIntPositive(env.TCLK_MKT_MIN_OFFER_INTERVAL_MS, 3_600_000, "TCLK_MKT_MIN_OFFER_INTERVAL_MS"),
    offerAmount: env.TCLK_MKT_OFFER_AMOUNT?.trim() || "1000000",
    offerAsset: env.TCLK_MKT_OFFER_ASSET?.trim() || "PAPER",
    offerJobType: env.TCLK_MKT_OFFER_JOB_TYPE?.trim() || "echo",
    offerExpiresMinutes: parseIntPositive(env.TCLK_MKT_OFFER_EXPIRES_MINUTES, 30, "TCLK_MKT_OFFER_EXPIRES_MINUTES"),
    claimMinutes,
    refundMinutes,

    pollIntervalMs: parseIntPositive(env.TCLK_MKT_POLL_INTERVAL_MS, 15_000, "TCLK_MKT_POLL_INTERVAL_MS"),
    longPollWaitSeconds,
    maxBackoffMs: parseIntPositive(env.TCLK_MKT_MAX_BACKOFF_MS, 30_000, "TCLK_MKT_MAX_BACKOFF_MS"),

    httpTimeoutMs: parseIntPositive(env.HTTP_TIMEOUT_MS, 15000, "HTTP_TIMEOUT_MS"),
    maxRetries: parseIntNonNegative(env.MAX_RETRIES, 2, "MAX_RETRIES"),

    logLevel: (env.TCLK_LOG_LEVEL?.trim().toLowerCase() || env.LOG_LEVEL?.trim().toLowerCase() || "info") === "debug" ? "debug" : "info",
  };
}
