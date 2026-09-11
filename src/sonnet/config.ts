/**
 * All `sonnet:*` configuration in one place, read once from process.env plus the
 * vendored, frozen contest package (vendor/technocore-sonnet/). Nothing else in
 * this feature reads process.env directly, same convention as
 * src/mentions/config.ts and src/verifier/config.ts.
 *
 * Identity: this feature never introduces its own identity path. It always signs
 * with whatever TECHNOCORE_IDENTITY_PATH already resolves to (the project's
 * existing "Agent A" / Radar identity) via identity.ts's loadIdentity() -- see
 * ./identity.ts. There is deliberately no SONNET_IDENTITY_PATH override: adding
 * one would create a second knob that could silently drift from the identity the
 * rest of this project already uses.
 *
 * Safety defaults: SONNET_DRY_RUN defaults to true and every SONNET_AUTO_* flag
 * defaults to false. A blank/missing .env is always safe to run preflight/scan
 * against -- see README.md "Sonnet Challenge".
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class SonnetConfigError extends Error {}

export interface SonnetConfig {
  /** Master switch for the autonomous daemon (`sonnet:run`). Preflight/scan/
   * status/register are diagnostic or explicitly user-invoked and always work
   * regardless of this flag. */
  enabled: boolean;
  /** Safety master switch. true (the default) means every write path (register,
   * team, roster, word proposals, submit, campaign, votes) only ever builds and
   * locally verifies a signed request -- it never sends it. */
  dryRun: boolean;

  pollIntervalMs: number;
  actionJitterMs: number;

  autoRegister: boolean;
  autoRecruit: boolean;
  autoTeam: boolean;
  autoWrite: boolean;
  autoSubmit: boolean;
  autoCampaign: boolean;

  technocoreBaseUrl: string;

  /** Root of the vendored, frozen contest package (unmodified snapshot of
   * flop-labs/technocore-sonnet-challenge -- see vendor/technocore-sonnet/VENDOR.json). */
  vendorRoot: string;

  statePath: string;
  wordCachePath: string;

  /** Extra candidate rooms (beyond the official contest rooms and this
   * project's own TECHNOCORE_ROOM) to scan for pre-cutoff signed evidence of
   * our DID during `sonnet:preflight`. Comma-separated room names. */
  eligibilityExtraRooms: string[];

  /** Minimum time between recruitment messages (recruit.ts) -- "no hacer
   * spam" per the operator's own instruction. Rate limit only; unrelated to
   * SONNET_POLL_INTERVAL_MS. */
  recruitMinIntervalMs: number;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseInt10(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new SonnetConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parseList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadSonnetConfig(env: NodeJS.ProcessEnv = process.env): SonnetConfig {
  return {
    enabled: parseBool(env.SONNET_ENABLED, false),
    dryRun: parseBool(env.SONNET_DRY_RUN, true),

    pollIntervalMs: parseInt10(env.SONNET_POLL_INTERVAL_MS, 30_000, "SONNET_POLL_INTERVAL_MS"),
    actionJitterMs: parseInt10(env.SONNET_ACTION_JITTER_MS, 5_000, "SONNET_ACTION_JITTER_MS"),

    autoRegister: parseBool(env.SONNET_AUTO_REGISTER, false),
    autoRecruit: parseBool(env.SONNET_AUTO_RECRUIT, false),
    autoTeam: parseBool(env.SONNET_AUTO_TEAM, false),
    autoWrite: parseBool(env.SONNET_AUTO_WRITE, false),
    autoSubmit: parseBool(env.SONNET_AUTO_SUBMIT, false),
    autoCampaign: parseBool(env.SONNET_AUTO_CAMPAIGN, false),

    technocoreBaseUrl: env.TECHNOCORE_URL?.trim() || "https://technocore.chat",

    vendorRoot: resolve(process.cwd(), env.SONNET_VENDOR_ROOT?.trim() || "vendor/technocore-sonnet"),

    statePath: env.SONNET_STATE_PATH?.trim() || "data/sonnet/state.json",
    wordCachePath: env.SONNET_WORD_CACHE_PATH?.trim() || "data/sonnet/agent-a-word-cache.json",

    eligibilityExtraRooms: parseList(env.SONNET_ELIGIBILITY_EXTRA_ROOMS),

    recruitMinIntervalMs: parseInt10(env.SONNET_RECRUIT_MIN_INTERVAL_MS, 1_800_000, "SONNET_RECRUIT_MIN_INTERVAL_MS"),
  };
}

// -- vendored contest.json -----------------------------------------------------

export interface ContestConfig {
  contest_id: string;
  rules_version: string;
  opening: string;
  deadline: string;
  prize: number;
  voter_pool: number;
  payment_unit: string;
  payment_method: string;
  theme: string | null;
  identity_policy: string;
  identity_cutoff: string;
}

let cachedContest: ContestConfig | undefined;

/**
 * Loads contest.json from the vendored package -- never hardcoded. Cached per
 * process (the vendored file never changes without a redeploy of this repo).
 */
export function loadContestConfig(config: SonnetConfig): ContestConfig {
  if (cachedContest) return cachedContest;
  const path = resolve(config.vendorRoot, "contest.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new SonnetConfigError(
      `no vendored contest.json at ${path}. Expected the frozen package under vendor/technocore-sonnet/ (see VENDOR.json).`,
    );
  }
  const parsed = JSON.parse(raw) as ContestConfig;
  if (!parsed.contest_id || !parsed.opening || !parsed.identity_cutoff) {
    throw new SonnetConfigError(`${path} is missing required fields (contest_id/opening/identity_cutoff)`);
  }
  cachedContest = parsed;
  return parsed;
}
