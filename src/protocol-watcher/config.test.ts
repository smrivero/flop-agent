import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProtocolWatcherConfig, ProtocolWatcherConfigError } from "./config.js";

test("config: sane, all-disabled defaults with an empty environment", () => {
  const config = loadProtocolWatcherConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.intervalHours, 6);
  assert.equal(config.telegramEnabled, false);
  assert.equal(config.technocoreEnabled, false);
  assert.equal(config.technocoreRoom, "d-flop-protocol-watch");
  assert.equal(config.llmSummaryEnabled, false);
  assert.equal(config.requestTimeoutMs, 15000);
  assert.equal(config.maxRetries, 2);
  assert.equal(config.retentionDays, 180);
  assert.equal(config.dbPath, ".data/protocol-watcher.sqlite3");
  assert.equal(config.sourcesPath, "config/protocol-sources.yaml");
});

test("config: TELEGRAM_ENABLED=true requires bot token + chat id", () => {
  assert.throws(() => loadProtocolWatcherConfig({ PROTOCOL_WATCHER_TELEGRAM_ENABLED: "true" }), ProtocolWatcherConfigError);
  const ok = loadProtocolWatcherConfig({
    PROTOCOL_WATCHER_TELEGRAM_ENABLED: "true",
    PROTOCOL_WATCHER_TELEGRAM_BOT_TOKEN: "123:abc",
    PROTOCOL_WATCHER_TELEGRAM_CHAT_ID: "999",
  });
  assert.equal(ok.telegramEnabled, true);
});

test("config: LLM_SUMMARY_ENABLED=true requires OPENAI_API_KEY + OPENAI_MODEL", () => {
  assert.throws(() => loadProtocolWatcherConfig({ PROTOCOL_WATCHER_LLM_SUMMARY_ENABLED: "true" }), ProtocolWatcherConfigError);
  const ok = loadProtocolWatcherConfig({
    PROTOCOL_WATCHER_LLM_SUMMARY_ENABLED: "true",
    OPENAI_API_KEY: "sk-x",
    OPENAI_MODEL: "gpt-5-nano",
  });
  assert.equal(ok.llmSummaryEnabled, true);
});

test("config: rejects a negative integer field", () => {
  assert.throws(() => loadProtocolWatcherConfig({ PROTOCOL_WATCHER_MAX_RETRIES: "-1" }), ProtocolWatcherConfigError);
});
