/**
 * All protocol-watcher configuration in one place, read once from process.env
 * -- same rule as mentions/config.ts: nothing else in this feature reads
 * process.env directly. The list of monitored URLs is deliberately NOT here
 * (see sources.ts / config/protocol-sources.yaml) -- this file is
 * infrastructure/secrets, that one is "what to watch".
 */

export class ProtocolWatcherConfigError extends Error {}

export interface ProtocolWatcherConfig {
  enabled: boolean;
  intervalHours: number;

  telegramEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;

  technocoreEnabled: boolean;
  technocoreRoom: string;

  llmSummaryEnabled: boolean;
  openAiApiKey?: string;
  openAiModel?: string;

  requestTimeoutMs: number;
  maxRetries: number;
  maxRedirects: number;
  maxResponseBytes: number;

  retentionDays: number;

  sourcesPath: string;
  dbPath: string;
  lockPath: string;
  contentDir: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseInt10(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new ProtocolWatcherConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return n;
}

export function loadProtocolWatcherConfig(env: NodeJS.ProcessEnv = process.env): ProtocolWatcherConfig {
  const telegramEnabled = parseBool(env.PROTOCOL_WATCHER_TELEGRAM_ENABLED, false);
  if (telegramEnabled && (!env.PROTOCOL_WATCHER_TELEGRAM_BOT_TOKEN || !env.PROTOCOL_WATCHER_TELEGRAM_CHAT_ID)) {
    throw new ProtocolWatcherConfigError(
      "PROTOCOL_WATCHER_TELEGRAM_BOT_TOKEN and PROTOCOL_WATCHER_TELEGRAM_CHAT_ID are required when PROTOCOL_WATCHER_TELEGRAM_ENABLED=true",
    );
  }

  const llmSummaryEnabled = parseBool(env.PROTOCOL_WATCHER_LLM_SUMMARY_ENABLED, false);
  if (llmSummaryEnabled && (!env.OPENAI_API_KEY || !env.OPENAI_MODEL)) {
    throw new ProtocolWatcherConfigError("OPENAI_API_KEY and OPENAI_MODEL are required when PROTOCOL_WATCHER_LLM_SUMMARY_ENABLED=true");
  }

  return {
    enabled: parseBool(env.PROTOCOL_WATCHER_ENABLED, false),
    intervalHours: parseInt10(env.PROTOCOL_WATCHER_INTERVAL_HOURS, 6, "PROTOCOL_WATCHER_INTERVAL_HOURS"),

    telegramEnabled,
    telegramBotToken: env.PROTOCOL_WATCHER_TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.PROTOCOL_WATCHER_TELEGRAM_CHAT_ID || undefined,

    technocoreEnabled: parseBool(env.PROTOCOL_WATCHER_TECHNOCORE_ENABLED, false),
    technocoreRoom: env.PROTOCOL_WATCHER_TECHNOCORE_ROOM?.trim() || "d-flop-protocol-watch",

    llmSummaryEnabled,
    openAiApiKey: env.OPENAI_API_KEY || undefined,
    openAiModel: env.OPENAI_MODEL || undefined,

    requestTimeoutMs: parseInt10(env.PROTOCOL_WATCHER_REQUEST_TIMEOUT_MS, 15000, "PROTOCOL_WATCHER_REQUEST_TIMEOUT_MS"),
    maxRetries: parseInt10(env.PROTOCOL_WATCHER_MAX_RETRIES, 2, "PROTOCOL_WATCHER_MAX_RETRIES"),
    maxRedirects: parseInt10(env.PROTOCOL_WATCHER_MAX_REDIRECTS, 5, "PROTOCOL_WATCHER_MAX_REDIRECTS"),
    maxResponseBytes: parseInt10(env.PROTOCOL_WATCHER_MAX_RESPONSE_BYTES, 10_000_000, "PROTOCOL_WATCHER_MAX_RESPONSE_BYTES"),

    retentionDays: parseInt10(env.PROTOCOL_WATCHER_RETENTION_DAYS, 180, "PROTOCOL_WATCHER_RETENTION_DAYS"),

    sourcesPath: env.PROTOCOL_WATCHER_SOURCES_PATH?.trim() || "config/protocol-sources.yaml",
    dbPath: env.PROTOCOL_WATCHER_DB_PATH?.trim() || ".data/protocol-watcher.sqlite3",
    lockPath: env.PROTOCOL_WATCHER_LOCK_PATH?.trim() || ".data/protocol-watcher.lock",
    contentDir: env.PROTOCOL_WATCHER_CONTENT_DIR?.trim() || ".data/protocol-watcher-content",
  };
}
