/**
 * Secrets/infrastructure (.env) and the conversation definition (config/debate.yaml)
 * are deliberately separate files, per the project's own requirement: changing the
 * room, topic, personalities or pacing must never mean editing source code, and
 * must never mean touching the file that holds API keys either.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentSpec, DebateConfig, DebateDefinition } from "./types.js";

export class DebateConfigError extends Error {}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new DebateConfigError(`${key} is required (set it in .env)`);
  return value;
}

function parseIntEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new DebateConfigError(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

function parseBoolEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultValue;
  return raw.trim().toLowerCase() === "true";
}

function parseFloatEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new DebateConfigError(`${key} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const SUPPORTED_INFERENCE_PROVIDERS = ["openai"] as const;

export function loadDebateConfig(env: NodeJS.ProcessEnv = process.env): DebateConfig {
  // 2-6 hours by default -- the original 1-5 minute defaults made this a spam
  // bot, not a persistent discussion. Still fully overridable per deployment.
  const minDelaySeconds = parseIntEnv(env, "MIN_DELAY_SECONDS", 7200);
  const maxDelaySeconds = parseIntEnv(env, "MAX_DELAY_SECONDS", 21600);
  if (maxDelaySeconds < minDelaySeconds) {
    throw new DebateConfigError(`MAX_DELAY_SECONDS (${maxDelaySeconds}) must be >= MIN_DELAY_SECONDS (${minDelaySeconds})`);
  }

  const logLevel = (env.LOG_LEVEL?.trim().toLowerCase() || "info") as DebateConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new DebateConfigError(`LOG_LEVEL must be one of debug/info/warn/error, got ${JSON.stringify(env.LOG_LEVEL)}`);
  }

  const webSearchEnabled = parseBoolEnv(env, "WEB_SEARCH_ENABLED", true);
  const webSearchRequired = parseBoolEnv(env, "WEB_SEARCH_REQUIRED", true);
  if (webSearchRequired && !webSearchEnabled) {
    throw new DebateConfigError("WEB_SEARCH_REQUIRED=true needs WEB_SEARCH_ENABLED=true too -- there's no tool to require a call from otherwise");
  }

  const inferenceProvider = (env.INFERENCE_PROVIDER?.trim().toLowerCase() || "openai") as DebateConfig["inferenceProvider"];
  if (!(SUPPORTED_INFERENCE_PROVIDERS as readonly string[]).includes(inferenceProvider)) {
    throw new DebateConfigError(
      `INFERENCE_PROVIDER=${JSON.stringify(env.INFERENCE_PROVIDER)} is not implemented. Only "openai" exists today -- ` +
        "see src/debate/inference.ts for the extension point a future FLOP provider would fill in.",
    );
  }

  return {
    inferenceProvider,

    openAiApiKey: requireEnv(env, "OPENAI_API_KEY"),
    openAiModel: requireEnv(env, "OPENAI_MODEL"),
    openAiMaxOutputTokens: parseIntEnv(env, "OPENAI_MAX_OUTPUT_TOKENS", 900),
    webSearchEnabled,
    webSearchRequired,

    technocoreBaseUrl: env.TECHNOCORE_BASE_URL?.trim() || "https://technocore.chat",

    agentAIdentityPath: env.AGENT_A_IDENTITY_PATH?.trim() || "./data/identities/agent-a.json",
    agentBIdentityPath: env.AGENT_B_IDENTITY_PATH?.trim() || "./data/identities/agent-b.json",

    debateConfigPath: env.DEBATE_CONFIG?.trim() || "./config/debate.yaml",

    minDelaySeconds,
    maxDelaySeconds,
    maxMessagesPerDay: parseIntEnv(env, "MAX_MESSAGES_PER_DAY", 4),
    allowSkipTurn: parseBoolEnv(env, "ALLOW_SKIP_TURN", true),
    historyMessages: parseIntEnv(env, "HISTORY_MESSAGES", 12),
    maxMessageChars: parseIntEnv(env, "MAX_MESSAGE_CHARS", 3500),
    repetitionThreshold: parseFloatEnv(env, "REPETITION_THRESHOLD", 0.45, 0, 1),
    repetitionContainmentThreshold: parseFloatEnv(env, "REPETITION_CONTAINMENT_THRESHOLD", 0.55, 0, 1),
    recentMessagesForSimilarity: parseIntEnv(env, "RECENT_MESSAGES_FOR_SIMILARITY", 8),

    checkpointEnabled: parseBoolEnv(env, "CHECKPOINT_ENABLED", true),
    checkpointEveryMessages: parseIntEnv(env, "CHECKPOINT_EVERY_MESSAGES", 10),

    archiveEnabled: parseBoolEnv(env, "ARCHIVE_ENABLED", true),
    archiveIntervalHours: parseIntEnv(env, "ARCHIVE_INTERVAL_HOURS", 24),

    identityMaintenanceEnabled: parseBoolEnv(env, "IDENTITY_MAINTENANCE_ENABLED", true),
    identityRefreshHours: parseIntEnv(env, "IDENTITY_REFRESH_HOURS", 72),

    httpTimeoutMs: parseIntEnv(env, "HTTP_TIMEOUT_MS", 30000),
    maxRetries: parseIntEnv(env, "MAX_RETRIES", 3),

    logLevel,

    statePath: env.DEBATE_STATE_PATH?.trim() || "./data/state",
    lockPath: env.DEBATE_LOCK_PATH?.trim() || "./data/state/debate.lock",
    archivePath: env.DEBATE_ARCHIVE_PATH?.trim() || "./data/archive",
  };
}

function requireField(obj: Record<string, unknown>, path: string, field: string): unknown {
  if (!(field in obj) || obj[field] === undefined || obj[field] === null || obj[field] === "") {
    throw new DebateConfigError(`${path}: missing required field "${field}"`);
  }
  return obj[field];
}

function parseAgentSpec(raw: unknown, path: string): AgentSpec {
  if (typeof raw !== "object" || raw === null) throw new DebateConfigError(`${path} must be an object`);
  const obj = raw as Record<string, unknown>;
  const name = requireField(obj, path, "name");
  const position = requireField(obj, path, "position");
  const personalityFile = requireField(obj, path, "personalityFile");
  if (typeof name !== "string" || typeof position !== "string" || typeof personalityFile !== "string") {
    throw new DebateConfigError(`${path}: name, position and personalityFile must all be strings`);
  }
  return { name, position, personalityFile };
}

/** Loads and validates config/debate.yaml. Personality file paths are resolved
 * relative to the YAML file's own directory, so the config is portable. */
export function loadDebateDefinition(path: string): DebateDefinition {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new DebateConfigError(`no debate config at ${path} (set DEBATE_CONFIG to point elsewhere)`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new DebateConfigError(`${path} is not valid YAML: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DebateConfigError(`${path} must contain a YAML mapping`);
  }
  const obj = parsed as Record<string, unknown>;

  const room = requireField(obj, path, "room");
  const topic = requireField(obj, path, "topic");
  const language = obj.language ?? "English";
  if (typeof room !== "string" || typeof topic !== "string" || typeof language !== "string") {
    throw new DebateConfigError(`${path}: room, topic and language must be strings`);
  }

  const configDir = dirname(resolve(path));
  const agentA = parseAgentSpec(obj.agentA, `${path}: agentA`);
  const agentB = parseAgentSpec(obj.agentB, `${path}: agentB`);
  agentA.personalityFile = resolve(configDir, agentA.personalityFile);
  agentB.personalityFile = resolve(configDir, agentB.personalityFile);

  let topicStartedAt: string | undefined;
  if (obj.topicStartedAt !== undefined) {
    const raw = obj.topicStartedAt;
    // This project's `yaml` parser keeps an ISO-looking scalar as a plain
    // string either way, but accept a native Date too (defensive -- some YAML
    // parsers auto-convert unquoted date-like scalars) so an unquoted
    // `topicStartedAt: 2026-09-02T20:00:00Z` never surprises whoever edits it.
    const value = raw instanceof Date ? raw.toISOString() : raw;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new DebateConfigError(`${path}: topicStartedAt must be a valid ISO timestamp, got ${JSON.stringify(raw)}`);
    }
    topicStartedAt = value;
  }

  let rotationTopics: string[] | undefined;
  if (obj.rotationTopics !== undefined) {
    if (!Array.isArray(obj.rotationTopics) || obj.rotationTopics.some((t) => typeof t !== "string" || t.trim() === "")) {
      throw new DebateConfigError(`${path}: rotationTopics must be a list of non-empty strings`);
    }
    rotationTopics = (obj.rotationTopics as string[]).map((t) => t.trim());
    if (rotationTopics.length === 0) rotationTopics = undefined; // an empty list means "no rotation", same as omitting the field
  }

  let rotationEveryMessages: number | undefined;
  if (obj.rotationEveryMessages !== undefined) {
    const n = obj.rotationEveryMessages;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new DebateConfigError(`${path}: rotationEveryMessages must be a positive integer, got ${JSON.stringify(n)}`);
    }
    rotationEveryMessages = n;
  }

  return { room: room.trim(), topic: topic.trim(), language: language.trim(), agentA, agentB, topicStartedAt, rotationTopics, rotationEveryMessages };
}

export function loadPersonality(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new DebateConfigError(`no personality file at ${path}`);
  }
}
