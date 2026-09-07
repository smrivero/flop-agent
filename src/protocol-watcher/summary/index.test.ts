import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTechnocoreSummary, summarizeForSource } from "./index.js";
import type { ProtocolChange, ProtocolSource } from "../types.js";
import { loadProtocolWatcherConfig } from "../config.js";

const SOURCE: ProtocolSource = { id: "yellowpaper", name: "Yellow Paper", url: "https://flop.finance/intro/yellowpaper/", kind: "html-flop", enabled: true };

const CHANGE: ProtocolChange = {
  sourceId: "yellowpaper",
  detectedAt: "2026-09-10T00:00:00.000Z",
  category: "validator",
  field: "validator_min_stake",
  changeType: "modified",
  severity: "action_required",
  previousValue: { value: "50_000 FLOP" },
  currentValue: { value: "75_000 FLOP" },
  evidence: { url: SOURCE.url },
};

test("summary: LLM disabled uses the deterministic fallback and never calls fetch", async () => {
  let called = false;
  const fakeLlm = async () => {
    called = true;
    return "should not be used";
  };
  const config = loadProtocolWatcherConfig({});
  const summary = summarizeForSource(SOURCE, [CHANGE], {});
  const result = await buildTechnocoreSummary(summary, config, undefined, fakeLlm);
  assert.equal(result.usedLlm, false);
  assert.equal(called, false);
  assert.match(result.text, /validator_min_stake/);
});

test("summary: LLM enabled and succeeding is used verbatim", async () => {
  const fakeLlm = async () => "LLM-written summary text.";
  const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_LLM_SUMMARY_ENABLED: "true", OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "gpt-5-nano" });
  const summary = summarizeForSource(SOURCE, [CHANGE], {});
  const result = await buildTechnocoreSummary(summary, config, undefined, fakeLlm);
  assert.equal(result.usedLlm, true);
  assert.equal(result.text, "LLM-written summary text.");
});

test("summary: LLM enabled but failing falls back to the deterministic summary without throwing", async () => {
  const fakeLlm = async () => {
    throw new Error("OpenAI is down");
  };
  const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_LLM_SUMMARY_ENABLED: "true", OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "gpt-5-nano" });
  const summary = summarizeForSource(SOURCE, [CHANGE], {});
  const result = await buildTechnocoreSummary(summary, config, undefined, fakeLlm);
  assert.equal(result.usedLlm, false);
  assert.equal(result.llmError, "OpenAI is down");
  assert.match(result.text, /validator_min_stake/);
});
