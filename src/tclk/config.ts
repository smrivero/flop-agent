/**
 * TCLK env config. Reuses TECHNOCORE_ROOM / TECHNOCORE_IDENTITY_PATH / OPENAI_*
 * / HTTP_TIMEOUT_MS / MAX_RETRIES / MENTIONS_DB_PATH from the existing pipelines
 * -- nothing here duplicates them. `TCLK_ALLOWED_PAYER_DID` defaults to Radar's
 * own DID, derived from TECHNOCORE_IDENTITY_PATH at load time, so no manual
 * .env edit is required to know which payer Agent B should trust.
 */

import { loadIdentity } from "../identity.js";

export class TclkConfigError extends Error {}
export class TclkSameDidError extends Error {}

/** Same guard as verifier/identity.ts, re-applied here: if Radar's and Agent
 * B's identity files ever resolve to the same DID, refuse to run -- that
 * would let Radar accept and settle its own offers. Extracted as a pure
 * function so it's testable without touching disk or a CLI process. */
export function assertDistinctPayerAndVerifierDids(radarDid: string, verifierDid: string, radarPath: string, verifierPath: string): void {
  if (radarDid === verifierDid) {
    throw new TclkSameDidError(
      `Radar and the TCLK verifier resolve to the same DID. Both ${radarPath} and ${verifierPath} sign as ${radarDid}. ` +
        "Refusing to run -- this would let Radar accept and settle its own offers.",
    );
  }
}

export type TclkRail = "paper";

export interface TclkConfig {
  tclkEnabled: boolean;
  rail: TclkRail;

  offerExpiresMinutes: number;
  claimMinutes: number;
  refundMinutes: number;

  amount: string;
  asset: string;

  /** The payer DID Agent B will accept offers from. Defaults to whatever
   * TECHNOCORE_IDENTITY_PATH (Radar's own identity) resolves to. */
  allowedPayerDid: string;

  room: string;
  identityPath: string;
  verifierIdentityPath: string;

  httpTimeoutMs: number;
  maxRetries: number;

  dbPath: string;
  /** Restricted local file custodying minted preimages until reveal -- never
   * the shared mentions DB. See secretStore.ts. */
  secretsPath: string;

  payerLockPath: string;
  verifierLockPath: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseInt10(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new TclkConfigError(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

export function loadTclkConfig(env: NodeJS.ProcessEnv = process.env): TclkConfig {
  const tclkEnabled = parseBool(env.TCLK_ENABLED, false);

  const rail = (env.TCLK_RAIL?.trim().toLowerCase() || "paper") as TclkRail;
  if (rail !== "paper") {
    throw new TclkConfigError(`TCLK_RAIL must be "paper" (no other rail is wired up yet), got ${JSON.stringify(env.TCLK_RAIL)}`);
  }

  const identityPath = env.TECHNOCORE_IDENTITY_PATH?.trim() || ".technocore/identity.json";

  const offerExpiresMinutes = parseInt10(env.TCLK_OFFER_EXPIRES_MINUTES, 30, "TCLK_OFFER_EXPIRES_MINUTES");
  const claimMinutes = parseInt10(env.TCLK_CLAIM_MINUTES, 60, "TCLK_CLAIM_MINUTES");
  const refundMinutes = parseInt10(env.TCLK_REFUND_MINUTES, 120, "TCLK_REFUND_MINUTES");
  if (claimMinutes >= refundMinutes) {
    throw new TclkConfigError("TCLK_CLAIM_MINUTES must be strictly less than TCLK_REFUND_MINUTES (tclk requires claimByMs < refundAfterMs)");
  }

  let allowedPayerDid = env.TCLK_ALLOWED_PAYER_DID?.trim();
  if (!allowedPayerDid) {
    // Safe to fail here rather than fall back silently: if Radar's identity
    // file is missing/corrupt, Agent B must not guess who to trust.
    allowedPayerDid = loadIdentity({ path: identityPath }).did;
  }

  return {
    tclkEnabled,
    rail,

    offerExpiresMinutes,
    claimMinutes,
    refundMinutes,

    // Matches examples/live-deal.mjs exactly -- PaperRail.id is hardcoded to
    // "paper", so `rails` must contain it verbatim regardless of TCLK_ASSET.
    amount: env.TCLK_AMOUNT?.trim() || "1000000",
    asset: env.TCLK_ASSET?.trim() || "PAPER",

    allowedPayerDid,

    room: env.TECHNOCORE_ROOM?.trim() || "d-technocore-radar",
    identityPath,
    verifierIdentityPath: env.VERIFIER_IDENTITY_PATH?.trim() || ".technocore/identityB.json",

    httpTimeoutMs: parseInt10(env.HTTP_TIMEOUT_MS, 15000, "HTTP_TIMEOUT_MS"),
    maxRetries: (() => {
      const raw = env.MAX_RETRIES;
      if (raw === undefined || raw === "") return 2;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) throw new TclkConfigError(`MAX_RETRIES must be a non-negative integer, got ${JSON.stringify(raw)}`);
      return n;
    })(),

    dbPath: env.MENTIONS_DB_PATH?.trim() || ".data/mentions.sqlite3",
    secretsPath: env.TCLK_SECRETS_PATH?.trim() || ".technocore/tclk-secrets.sqlite3",

    payerLockPath: env.TCLK_PAYER_LOCK_PATH?.trim() || ".data/tclk-payer.lock",
    verifierLockPath: env.TCLK_VERIFIER_LOCK_PATH?.trim() || ".data/tclk-verifier.lock",
  };
}
