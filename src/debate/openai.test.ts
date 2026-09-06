import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { generateDebateTurn, WebSearchNotPerformedError } from "./openai.js";
import type { DebateConfig } from "./types.js";

function baseConfig(overrides: Partial<DebateConfig> = {}): DebateConfig {
  return {
    inferenceProvider: "openai",
    openAiApiKey: "sk-test",
    openAiModel: "gpt-test",
    openAiMaxOutputTokens: 900,
    webSearchEnabled: true,
    webSearchRequired: true,
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
    repetitionContainmentThreshold: 0.55,
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

/** A fake OpenAI client -- never calls the real API. `create` records the last
 * request params so a test can inspect exactly what was sent. */
function fakeOpenAiClient(response: unknown): { client: OpenAI; lastParams: () => unknown } {
  let lastParams: unknown;
  const client = {
    responses: {
      create: async (params: unknown) => {
        lastParams = params;
        return response;
      },
    },
  } as unknown as OpenAI;
  return { client, lastParams: () => lastParams };
}

const RESPONSE_WITHOUT_SEARCH = {
  output_text: "Fifteen European Cups. Full stop.",
  output: [{ type: "message", content: [{ type: "output_text", text: "Fifteen European Cups. Full stop." }] }],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
};

const RESPONSE_WITH_SEARCH = {
  output_text: "Per UEFA, Madrid has 15 European Cups as of this season.",
  output: [
    {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "Real Madrid European Cup count 2026", sources: ["https://www.uefa.com/", "https://www.realmadrid.com/"] },
    },
    { type: "message", content: [{ type: "output_text", text: "Per UEFA, Madrid has 15 European Cups as of this season." }] },
  ],
  usage: { input_tokens: 150, output_tokens: 25, total_tokens: 175 },
};

test("generateDebateTurn: WEB_SEARCH_REQUIRED rejects a response with no web_search_call", async () => {
  const { client } = fakeOpenAiClient(RESPONSE_WITHOUT_SEARCH);
  const config = baseConfig({ webSearchEnabled: true, webSearchRequired: true });

  await assert.rejects(
    () => generateDebateTurn(client, config, { instructions: "i", input: "u" }),
    WebSearchNotPerformedError,
  );
});

test("generateDebateTurn: does not publish -- the text from an unverified response never surfaces to the caller", async () => {
  const { client } = fakeOpenAiClient(RESPONSE_WITHOUT_SEARCH);
  const config = baseConfig({ webSearchRequired: true });
  try {
    await generateDebateTurn(client, config, { instructions: "i", input: "u" });
    assert.fail("expected generateDebateTurn to throw");
  } catch (err) {
    assert.ok(err instanceof WebSearchNotPerformedError);
    // The stale/unverified text ("Fifteen European Cups. Full stop.") must not
    // appear anywhere reachable from a thrown error a caller might log.
    assert.ok(!String(err).includes("Fifteen European Cups"));
  }
});

test("generateDebateTurn: succeeds and extracts queries/sources when a web_search_call is present", async () => {
  const { client } = fakeOpenAiClient(RESPONSE_WITH_SEARCH);
  const config = baseConfig({ webSearchRequired: true });

  const result = await generateDebateTurn(client, config, { instructions: "i", input: "u" });

  assert.equal(result.text, "Per UEFA, Madrid has 15 European Cups as of this season.");
  assert.equal(result.webSearch.called, true);
  assert.deepEqual(result.webSearch.queries, ["Real Madrid European Cup count 2026"]);
  assert.deepEqual(result.webSearch.sources, ["https://www.uefa.com/", "https://www.realmadrid.com/"]);
  assert.equal(result.usage?.inputTokens, 150);
});

test("generateDebateTurn: WEB_SEARCH_REQUIRED=false does not reject a response with no web_search_call", async () => {
  const { client } = fakeOpenAiClient(RESPONSE_WITHOUT_SEARCH);
  const config = baseConfig({ webSearchEnabled: true, webSearchRequired: false });

  const result = await generateDebateTurn(client, config, { instructions: "i", input: "u" });
  assert.equal(result.text, "Fifteen European Cups. Full stop.");
  assert.equal(result.webSearch.called, false);
});

test("generateDebateTurn: sends tool_choice 'required' and the web_search tool when web search is enabled", async () => {
  const { client, lastParams } = fakeOpenAiClient(RESPONSE_WITH_SEARCH);
  const config = baseConfig({ webSearchEnabled: true, webSearchRequired: true });

  await generateDebateTurn(client, config, { instructions: "i", input: "u" });

  const params = lastParams() as { tool_choice?: unknown; tools?: unknown[]; include?: unknown };
  assert.equal(params.tool_choice, "required");
  assert.deepEqual(params.tools, [{ type: "web_search" }]);
  assert.deepEqual(params.include, ["web_search_call.action.sources"]);
});

test("generateDebateTurn: omits the tool entirely when web search is disabled", async () => {
  const { client, lastParams } = fakeOpenAiClient(RESPONSE_WITHOUT_SEARCH);
  const config = baseConfig({ webSearchEnabled: false, webSearchRequired: false });

  await generateDebateTurn(client, config, { instructions: "i", input: "u" });

  const params = lastParams() as { tool_choice?: unknown; tools?: unknown };
  assert.equal(params.tools, undefined);
  assert.equal(params.tool_choice, undefined);
});

test("generateDebateTurn: throws a plain error when the model returns no text at all", async () => {
  const { client } = fakeOpenAiClient({ output_text: "", output: [], usage: undefined });
  const config = baseConfig({ webSearchEnabled: false, webSearchRequired: false });
  await assert.rejects(() => generateDebateTurn(client, config, { instructions: "i", input: "u" }));
});
