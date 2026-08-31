import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOneTurn, randomDelaySeconds, sleep } from "./loop.js";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocoreServer, makeTestIdentity, buildTestAgent } from "./testUtils.js";
import { loadState } from "./state.js";
import type { Runtime } from "./runtime.js";
import type { DebateConfig, DebateDefinition } from "./types.js";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "debate-loop-test-"));
}

function buildTestRuntime(overrides: { server?: FakeTechnocoreServer; statePath?: string } = {}): Runtime {
  const server = overrides.server ?? new FakeTechnocoreServer();
  const identityA = makeTestIdentity();
  const identityB = makeTestIdentity();
  const agentA = buildTestAgent("A", identityA, "cules-ai", "madridista-ai");
  const agentB = buildTestAgent("B", identityB, "madridista-ai", "cules-ai");

  const config: DebateConfig = {
    openAiApiKey: "sk-test",
    openAiModel: "gpt-test",
    openAiMaxOutputTokens: 900,
    webSearchEnabled: false,
    technocoreBaseUrl: "https://technocore.chat",
    agentAIdentityPath: "unused-in-tests.json",
    agentBIdentityPath: "unused-in-tests.json",
    debateConfigPath: "unused-in-tests.yaml",
    minDelaySeconds: 60,
    maxDelaySeconds: 300,
    historyMessages: 12,
    maxMessageChars: 200,
    httpTimeoutMs: 5000,
    maxRetries: 0,
    logLevel: "info",
    statePath: overrides.statePath ?? tempStateDir(),
    lockPath: "unused-in-tests.lock",
  };

  const definition: DebateDefinition = {
    room: "d-testroom",
    topic: "Bitcoin vs Gold",
    language: "English",
    agentA: { name: "cules-ai", position: agentA.position, personalityFile: "unused" },
    agentB: { name: "madridista-ai", position: agentB.position, personalityFile: "unused" },
  };

  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  return { config, definition, agentA, agentB, agentACreated: false, agentBCreated: false, client, openai: {} as never };
}

test("randomDelaySeconds: always within [min, max]", () => {
  for (let i = 0; i < 500; i++) {
    const delay = randomDelaySeconds(60, 300);
    assert.ok(delay >= 60 && delay <= 300, `delay ${delay} out of range`);
  }
});

test("randomDelaySeconds: min === max always returns that exact value", () => {
  for (let i = 0; i < 20; i++) {
    assert.equal(randomDelaySeconds(120, 120), 120);
  }
});

test("sleep: resolves promptly when the abort signal fires, without waiting the full duration", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const sleepPromise = sleep(60_000, controller.signal);
  controller.abort();
  await sleepPromise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected near-instant resolution, took ${elapsed}ms`);
});

test("sleep: an already-aborted signal resolves immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await sleep(60_000, controller.signal);
  assert.ok(Date.now() - start < 100);
});

test("runOneTurn: Agent A speaks first in an empty room", async () => {
  const runtime = buildTestRuntime();
  const result = await runOneTurn(runtime, { generate: async () => ({ text: "Opening argument for cules-ai." }) });
  assert.equal(result.speakerId, "A");
  assert.equal(result.speakerName, "cules-ai");

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 1);
  assert.equal(view.messages[0].from, runtime.agentA.did);
  assert.equal(view.messages[0].text, "Opening argument for cules-ai.");
});

test("runOneTurn: alternates correctly across consecutive turns", async () => {
  const runtime = buildTestRuntime();
  let n = 0;
  const generate = async () => ({ text: `Message number ${++n}.` });

  const first = await runOneTurn(runtime, { generate });
  const second = await runOneTurn(runtime, { generate });
  const third = await runOneTurn(runtime, { generate });

  assert.deepEqual([first.speakerId, second.speakerId, third.speakerId], ["A", "B", "A"]);
});

test("restart recovery: a message already in the room (crash before local state was saved) is not reposted, and the OTHER agent speaks next", async () => {
  const server = new FakeTechnocoreServer();
  const runtime = buildTestRuntime({ server });

  // Simulate: Agent A successfully posted, then the process crashed before
  // writing local state (loadState below reads a directory with no file in it
  // at all, exactly as if this were a fresh process).
  server.seedMessage("d-testroom", runtime.agentA.did, "Agent A's message that already landed", 1);

  const state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.totalMessages, 0); // confirms local state genuinely knows nothing about it

  let generateCalls = 0;
  const result = await runOneTurn(runtime, {
    generate: async () => {
      generateCalls++;
      return { text: "Agent B's reply." };
    },
  });

  assert.equal(result.speakerId, "B"); // NOT Agent A again
  assert.equal(generateCalls, 1);

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 2); // the pre-existing message plus exactly one new one
  assert.equal(view.messages[0].text, "Agent A's message that already landed"); // untouched, not reposted
  assert.equal(view.messages[1].from, runtime.agentB.did);
});

test("runOneTurn: sanitizes model output (multi-line, over-length) before signing and posting", async () => {
  const runtime = buildTestRuntime(); // maxMessageChars: 200 in buildTestRuntime's config
  const longText = "First line of argument.\nSecond line goes on and on. ".repeat(20);

  await runOneTurn(runtime, { generate: async () => ({ text: longText }) });

  const view = await runtime.client.readRoom("d-testroom");
  const posted = view.messages[0].text;
  assert.ok(!posted.includes("\n"));
  assert.ok(posted.length <= 200);
});

test("runOneTurn: local state records the speaker DID and increments totalMessages", async () => {
  const runtime = buildTestRuntime();
  await runOneTurn(runtime, { generate: async () => ({ text: "First message." }) });
  const state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.totalMessages, 1);
  assert.equal(state.lastSpeakerDid, runtime.agentA.did);
  assert.ok(state.recentClaims.length > 0);
});
