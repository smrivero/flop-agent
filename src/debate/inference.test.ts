import { test } from "node:test";
import assert from "node:assert/strict";
import { createInferenceProvider, OpenAIInferenceProvider, type InferenceProvider } from "./inference.js";
import type { DebateConfig } from "./types.js";

function baseConfig(overrides: Partial<DebateConfig> = {}): DebateConfig {
  return {
    inferenceProvider: "openai",
    openAiApiKey: "sk-test",
    openAiModel: "gpt-test",
    openAiMaxOutputTokens: 900,
    webSearchEnabled: false,
    webSearchRequired: false,
    technocoreBaseUrl: "https://technocore.chat",
    agentAIdentityPath: "unused",
    agentBIdentityPath: "unused",
    debateConfigPath: "unused",
    minDelaySeconds: 60,
    maxDelaySeconds: 300,
    maxMessagesPerDay: 4,
    allowSkipTurn: true,
    historyMessages: 12,
    maxMessageChars: 3500,
    repetitionThreshold: 0.45,
    recentMessagesForSimilarity: 8,
    checkpointEnabled: true,
    checkpointEveryMessages: 10,
    archiveEnabled: false,
    archiveIntervalHours: 24,
    identityMaintenanceEnabled: false,
    identityRefreshHours: 72,
    httpTimeoutMs: 5000,
    maxRetries: 0,
    logLevel: "info",
    statePath: "unused",
    lockPath: "unused",
    archivePath: "unused",
    ...overrides,
  };
}

test("createInferenceProvider: 'openai' builds an OpenAIInferenceProvider", () => {
  const provider = createInferenceProvider({} as never, baseConfig());
  assert.ok(provider instanceof OpenAIInferenceProvider);
});

test("createInferenceProvider: an unsupported provider throws rather than silently defaulting to OpenAI", () => {
  assert.throws(() => createInferenceProvider({} as never, baseConfig({ inferenceProvider: "flop" as never })), /Unknown INFERENCE_PROVIDER/);
});

test("InferenceProvider: the orchestrator only needs generateTurn(input) -> Promise<output> -- a fake provider satisfies the interface with no OpenAI SDK involved", async () => {
  const calls: unknown[] = [];
  const fake: InferenceProvider = {
    generateTurn: async (input) => {
      calls.push(input);
      return { text: "fake response", webSearch: { called: true, queries: ["q"], sources: [] } };
    },
  };
  const result = await fake.generateTurn({ instructions: "be nice", input: "say something" });
  assert.equal(result.text, "fake response");
  assert.equal(calls.length, 1);
});

test("OpenAIInferenceProvider: delegates to the real client via generateDebateTurn (exercised indirectly through a fake OpenAI client)", async () => {
  const fakeOpenAiClient = {
    responses: {
      create: async () => ({
        output_text: "Hello from the fake OpenAI client.",
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    },
  };
  const provider = new OpenAIInferenceProvider(fakeOpenAiClient as never, baseConfig());
  const result = await provider.generateTurn({ instructions: "x", input: "y" });
  assert.equal(result.text, "Hello from the fake OpenAI client.");
  assert.equal(result.usage?.totalTokens, 15);
});
