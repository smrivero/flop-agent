/**
 * Reuses the mentions pipeline's env vars wherever the same thing is meant
 * (OPENAI_API_KEY, HTTP_TIMEOUT_MS, MAX_RETRIES, MENTIONS_DB_PATH -- same
 * SQLite file Radar writes to, on purpose, since the Verifier reads Radar's
 * findings directly). The only genuinely new path variable is
 * VERIFIER_IDENTITY_PATH, and it has a working default
 * (.technocore/identityB.json) -- no .env edit is required to run this.
 */

export class VerifierConfigError extends Error {}

export interface VerifierConfig {
  verifierEnabled: boolean;
  verifierMaxPerRun: number;
  verifierSampleRate: number;
  verifierModel?: string;

  openAiApiKey?: string;

  /** Agent B's identity -- the Verifier always signs with this, never with
   * radarIdentityPath. */
  verifierIdentityPath: string;
  /** Agent A's (Radar's) identity path -- read only to compare DIDs at
   * startup (see verifier/identity.ts) as a safety check, never to sign. */
  radarIdentityPath: string;

  httpTimeoutMs: number;
  maxRetries: number;
  /** Reuses MAX_CONTENT_CHARS -- same cap Radar applies to its own extracted content. */
  maxContentChars: number;

  dbPath: string;
  lockPath: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseInt10(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new VerifierConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return n;
}

function parseRate(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new VerifierConfigError(`VERIFIER_SAMPLE_RATE must be between 0 and 1, got ${JSON.stringify(value)}`);
  return n;
}

export function loadVerifierConfig(env: NodeJS.ProcessEnv = process.env): VerifierConfig {
  const verifierEnabled = parseBool(env.VERIFIER_ENABLED, true);
  const verifierModel = env.VERIFIER_MODEL?.trim() || env.OPENAI_MODEL?.trim() || undefined;

  if (verifierEnabled) {
    if (!env.OPENAI_API_KEY) throw new VerifierConfigError("OPENAI_API_KEY is required when VERIFIER_ENABLED=true");
    if (!verifierModel) throw new VerifierConfigError("VERIFIER_MODEL (or OPENAI_MODEL as a fallback) is required when VERIFIER_ENABLED=true");
  }

  return {
    verifierEnabled,
    verifierMaxPerRun: parseInt10(env.VERIFIER_MAX_PER_RUN, 2, "VERIFIER_MAX_PER_RUN"),
    verifierSampleRate: parseRate(env.VERIFIER_SAMPLE_RATE, 1),
    verifierModel,

    openAiApiKey: env.OPENAI_API_KEY || undefined,

    verifierIdentityPath: env.VERIFIER_IDENTITY_PATH?.trim() || ".technocore/identityB.json",
    radarIdentityPath: env.TECHNOCORE_IDENTITY_PATH?.trim() || ".technocore/identity.json",

    httpTimeoutMs: parseInt10(env.HTTP_TIMEOUT_MS, 15000, "HTTP_TIMEOUT_MS"),
    maxRetries: parseInt10(env.MAX_RETRIES, 2, "MAX_RETRIES"),
    maxContentChars: parseInt10(env.MAX_CONTENT_CHARS, 12000, "MAX_CONTENT_CHARS"),

    dbPath: env.MENTIONS_DB_PATH?.trim() || ".data/mentions.sqlite3",
    lockPath: env.VERIFIER_LOCK_PATH?.trim() || ".data/verifier.lock",
  };
}
