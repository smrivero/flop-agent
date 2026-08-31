import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDebateConfig, loadDebateDefinition, loadPersonality, DebateConfigError } from "./config.js";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "debate-config-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

test("config: loads required + defaulted env vars", () => {
  const config = loadDebateConfig({ OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "gpt-test" });
  assert.equal(config.openAiApiKey, "sk-x");
  assert.equal(config.openAiModel, "gpt-test");
  assert.equal(config.minDelaySeconds, 60);
  assert.equal(config.maxDelaySeconds, 300);
  assert.equal(config.historyMessages, 12);
  assert.equal(config.maxMessageChars, 3500);
  assert.equal(config.webSearchEnabled, true);
});

test("config: OPENAI_API_KEY and OPENAI_MODEL are required", () => {
  assert.throws(() => loadDebateConfig({}), DebateConfigError);
  assert.throws(() => loadDebateConfig({ OPENAI_API_KEY: "sk-x" }), DebateConfigError);
});

test("config: MAX_DELAY_SECONDS must be >= MIN_DELAY_SECONDS", () => {
  assert.throws(
    () => loadDebateConfig({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m", MIN_DELAY_SECONDS: "300", MAX_DELAY_SECONDS: "60" }),
    DebateConfigError,
  );
  assert.doesNotThrow(() =>
    loadDebateConfig({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m", MIN_DELAY_SECONDS: "120", MAX_DELAY_SECONDS: "120" }),
  );
});

test("config: rejects an invalid LOG_LEVEL", () => {
  assert.throws(() => loadDebateConfig({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m", LOG_LEVEL: "verbose" }), DebateConfigError);
});

test("debate definition: loads a valid YAML file and resolves personality paths relative to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "debate-yaml-test-"));
  writeFileSync(
    join(dir, "debate.yaml"),
    [
      "room: d-testroom",
      "topic: Bitcoin vs Gold",
      "agentA:",
      "  name: btc-ai",
      "  position: Bitcoin is superior",
      "  personalityFile: ./btc.md",
      "agentB:",
      "  name: gold-ai",
      "  position: Gold is superior",
      "  personalityFile: ./gold.md",
    ].join("\n"),
  );
  const definition = loadDebateDefinition(join(dir, "debate.yaml"));
  assert.equal(definition.room, "d-testroom");
  assert.equal(definition.topic, "Bitcoin vs Gold");
  assert.equal(definition.language, "English"); // default
  assert.equal(definition.agentA.name, "btc-ai");
  assert.ok(definition.agentA.personalityFile.endsWith(join(dir, "btc.md")) || definition.agentA.personalityFile === join(dir, "btc.md"));
});

test("debate definition: a multi-line YAML block-scalar topic is folded (matches the Barcelona example)", () => {
  const dir = mkdtempSync(join(tmpdir(), "debate-yaml-test-"));
  writeFileSync(
    join(dir, "debate.yaml"),
    [
      "room: d-elclasico",
      "topic: >",
      "  Two autonomous football agents debate which is the greatest club:",
      "  FC Barcelona or Real Madrid.",
      "agentA:\n  name: a\n  position: p\n  personalityFile: ./a.md",
      "agentB:\n  name: b\n  position: p\n  personalityFile: ./b.md",
    ].join("\n"),
  );
  const definition = loadDebateDefinition(join(dir, "debate.yaml"));
  assert.equal(definition.topic, "Two autonomous football agents debate which is the greatest club: FC Barcelona or Real Madrid.");
});

test("debate definition: missing required fields fail clearly", () => {
  const path = tmpFile("bad.yaml", "room: d-x\n");
  assert.throws(() => loadDebateDefinition(path), DebateConfigError);
});

test("debate definition: missing file fails clearly", () => {
  assert.throws(() => loadDebateDefinition("/nonexistent/debate.yaml"), DebateConfigError);
});

test("loadPersonality: reads and trims a file, throws clearly if missing", () => {
  const path = tmpFile("p.md", "  You are a debater.  \n");
  assert.equal(loadPersonality(path), "You are a debater.");
  assert.throws(() => loadPersonality("/nonexistent/p.md"), DebateConfigError);
});
