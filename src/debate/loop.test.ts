import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOneTurn, randomDelaySeconds, sleep, currentRotationTopic } from "./loop.js";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocoreServer, makeTestIdentity, buildTestAgent } from "./testUtils.js";
import { loadState, saveState } from "./state.js";
import type { Runtime } from "./runtime.js";
import type { DebateConfig, DebateDefinition } from "./types.js";
import type { GenerateTurnResult } from "./openai.js";

/** A generate() mock result -- no web search performed (these tests don't exercise that path). */
function textResult(text: string): GenerateTurnResult {
  return { text, webSearch: { called: false, queries: [], sources: [] } };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "debate-loop-test-"));
}

function buildTestRuntime(
  overrides: {
    server?: FakeTechnocoreServer;
    statePath?: string;
    maxMessagesPerDay?: number;
    allowSkipTurn?: boolean;
    checkpointEnabled?: boolean;
    checkpointEveryMessages?: number;
    rotationTopics?: string[];
    rotationEveryMessages?: number;
  } = {},
): Runtime {
  const server = overrides.server ?? new FakeTechnocoreServer();
  const identityA = makeTestIdentity();
  const identityB = makeTestIdentity();
  const agentA = buildTestAgent("A", identityA, "cules-ai", "madridista-ai");
  const agentB = buildTestAgent("B", identityB, "madridista-ai", "cules-ai");

  const config: DebateConfig = {
    inferenceProvider: "openai",
    openAiApiKey: "sk-test",
    openAiModel: "gpt-test",
    openAiMaxOutputTokens: 900,
    webSearchEnabled: false,
    webSearchRequired: false,
    technocoreBaseUrl: "https://technocore.chat",
    agentAIdentityPath: "unused-in-tests.json",
    agentBIdentityPath: "unused-in-tests.json",
    debateConfigPath: "unused-in-tests.yaml",
    minDelaySeconds: 60,
    maxDelaySeconds: 300,
    maxMessagesPerDay: overrides.maxMessagesPerDay ?? 4,
    allowSkipTurn: overrides.allowSkipTurn ?? true,
    historyMessages: 12,
    maxMessageChars: 200,
    repetitionThreshold: 0.45,
    repetitionContainmentThreshold: 0.55,
    recentMessagesForSimilarity: 8,
    checkpointEnabled: overrides.checkpointEnabled ?? false,
    checkpointEveryMessages: overrides.checkpointEveryMessages ?? 10,
    archiveEnabled: false,
    archiveIntervalHours: 24,
    identityMaintenanceEnabled: false,
    identityRefreshHours: 72,
    httpTimeoutMs: 5000,
    maxRetries: 0,
    logLevel: "info",
    statePath: overrides.statePath ?? tempStateDir(),
    lockPath: "unused-in-tests.lock",
    archivePath: "unused-in-tests-archive",
  };

  const definition: DebateDefinition = {
    room: "d-testroom",
    topic: "Bitcoin vs Gold",
    language: "English",
    agentA: { name: "cules-ai", position: agentA.position, personalityFile: "unused" },
    agentB: { name: "madridista-ai", position: agentB.position, personalityFile: "unused" },
    rotationTopics: overrides.rotationTopics,
    rotationEveryMessages: overrides.rotationEveryMessages,
  };

  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  return {
    config,
    definition,
    agentA,
    agentB,
    agentACreated: false,
    agentBCreated: false,
    client,
    openai: {} as never,
    inferenceProvider: { generateTurn: async () => ({ text: "unused -- tests inject deps.generate instead", webSearch: { called: false, queries: [], sources: [] } }) },
  };
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

// -- currentRotationTopic ----------------------------------------------------

function rotationDefinition(rotationTopics?: string[], rotationEveryMessages?: number): DebateDefinition {
  return {
    room: "d-testroom",
    topic: "Memecoins",
    language: "English",
    agentA: { name: "a", position: "p", personalityFile: "unused" },
    agentB: { name: "b", position: "p", personalityFile: "unused" },
    rotationTopics,
    rotationEveryMessages,
  };
}

test("currentRotationTopic: undefined when the definition has no rotationTopics", () => {
  assert.equal(currentRotationTopic(rotationDefinition(), 0), undefined);
  assert.equal(currentRotationTopic(rotationDefinition([]), 5), undefined);
});

test("currentRotationTopic: stays on the same entry for rotationEveryMessages messages, then advances", () => {
  const def = rotationDefinition(["Dogecoin", "Pepe", "Bonk"], 4);
  assert.equal(currentRotationTopic(def, 0), "Dogecoin");
  assert.equal(currentRotationTopic(def, 1), "Dogecoin");
  assert.equal(currentRotationTopic(def, 3), "Dogecoin");
  assert.equal(currentRotationTopic(def, 4), "Pepe");
  assert.equal(currentRotationTopic(def, 7), "Pepe");
  assert.equal(currentRotationTopic(def, 8), "Bonk");
});

test("currentRotationTopic: wraps back to the first entry after the list is exhausted", () => {
  const def = rotationDefinition(["Dogecoin", "Pepe"], 4);
  assert.equal(currentRotationTopic(def, 8), "Dogecoin");
  assert.equal(currentRotationTopic(def, 12), "Pepe");
});

test("currentRotationTopic: defaults rotationEveryMessages to 4 when unset", () => {
  const def = rotationDefinition(["Dogecoin", "Pepe"]);
  assert.equal(currentRotationTopic(def, 3), "Dogecoin");
  assert.equal(currentRotationTopic(def, 4), "Pepe");
});

test("runOneTurn: Agent A speaks first in an empty room", async () => {
  const runtime = buildTestRuntime();
  const result = await runOneTurn(runtime, { generate: async () => textResult("Opening argument for cules-ai.") });
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
  const generate = async () => textResult(`Message number ${++n}.`);

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
      return textResult("Agent B's reply.");
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

  await runOneTurn(runtime, { generate: async () => textResult(longText) });

  const view = await runtime.client.readRoom("d-testroom");
  const posted = view.messages[0].text;
  assert.ok(!posted.includes("\n"));
  assert.ok(posted.length <= 200);
});

test("runOneTurn: local state records the speaker DID and increments totalMessages", async () => {
  const runtime = buildTestRuntime();
  await runOneTurn(runtime, { generate: async () => textResult("First message.") });
  const state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.totalMessages, 1);
  assert.equal(state.lastSpeakerDid, runtime.agentA.did);
  assert.ok(state.recentClaims.length > 0);
});

// -- SKIP -----------------------------------------------------------------

test("SKIP: an exact 'SKIP' response is not signed, not published, and the turn is reported as skipped", async () => {
  const runtime = buildTestRuntime();
  let generateCalls = 0;
  const result = await runOneTurn(runtime, {
    generate: async () => {
      generateCalls++;
      return textResult("SKIP");
    },
  });

  assert.equal(result.outcome, "skipped");
  assert.equal(generateCalls, 1); // no regeneration for a deliberate SKIP

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 0); // nothing published
});

test("SKIP: does not increment totalMessages or messagesToday", async () => {
  const runtime = buildTestRuntime();
  await runOneTurn(runtime, { generate: async () => textResult("SKIP") });
  const state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.totalMessages, 0);
  assert.equal(state.messagesToday, 0);
});

test("SKIP: a claims trailer attached to a SKIP response is ignored -- still a skip, nothing published", async () => {
  const runtime = buildTestRuntime();
  const result = await runOneTurn(runtime, {
    generate: async () => textResult('SKIP\n\n===CLAIMS===\n[{"claim":"x","status":"unverified"}]'),
  });
  assert.equal(result.outcome, "skipped");
  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 0);
});

test("SKIP: with ALLOW_SKIP_TURN=false, the model saying SKIP still never gets published as a literal message", async () => {
  const runtime = buildTestRuntime({ allowSkipTurn: false });
  const result = await runOneTurn(runtime, { generate: async () => textResult("SKIP") });
  assert.equal(result.outcome, "skipped");
  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 0); // never publishes the literal word "SKIP"
});

// -- daily message limit ---------------------------------------------------

test("daily limit: once MAX_MESSAGES_PER_DAY is reached, the turn is not generated or published", async () => {
  const runtime = buildTestRuntime({ maxMessagesPerDay: 2 });
  let generateCalls = 0;
  const generate = async () => {
    generateCalls++;
    return textResult(`Message ${generateCalls}.`);
  };

  await runOneTurn(runtime, { generate });
  await runOneTurn(runtime, { generate });
  assert.equal(generateCalls, 2);

  const third = await runOneTurn(runtime, { generate });
  assert.equal(third.outcome, "daily-limit");
  assert.equal(generateCalls, 2); // no OpenAI call spent on the gated turn

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 2); // nothing new published
});

test("daily limit: a new UTC day allows publishing again without any manual reset", async () => {
  const runtime = buildTestRuntime({ maxMessagesPerDay: 1 });
  await runOneTurn(runtime, { generate: async () => textResult("Today's only message.") });

  let state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.messagesToday, 1);

  // Simulate a new day by rewriting the persisted state's currentDay directly
  // (recordTurn's own day-rollover is exercised in state.test.ts already;
  // this test is about runOneTurn respecting it end to end).
  saveState(runtime.config.statePath, { ...state, currentDay: "2000-01-01" });

  const result = await runOneTurn(runtime, { generate: async () => textResult("Next day's message.") });
  assert.equal(result.outcome, "published");
});

// -- claim state -------------------------------------------------------------

test("claims: a claims trailer on a published message updates claimRecords and claimStats", async () => {
  const runtime = buildTestRuntime();
  await runOneTurn(runtime, {
    generate: async () =>
      textResult(
        'Checked it, UEFA confirms 15.\n\n===CLAIMS===\n[{"claim":"Real Madrid has 15 European Cups","status":"verified","sources":["https://uefa.com/x"]}]',
      ),
  });

  const state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.claimRecords.length, 1);
  assert.equal(state.claimRecords[0].claim, "Real Madrid has 15 European Cups");
  assert.equal(state.claimRecords[0].status, "verified");
  assert.equal(state.claimStats.verified, 1);

  // The trailer itself must never reach the public room.
  const view = await runtime.client.readRoom("d-testroom");
  assert.ok(!view.messages[0].text.includes("===CLAIMS==="));
  assert.ok(!view.messages[0].text.includes('"status"'));
});

// -- checkpoints -------------------------------------------------------------

test("checkpoint: due after N messages, replaces a normal reply, no generate() call spent", async () => {
  const runtime = buildTestRuntime({ checkpointEnabled: true, checkpointEveryMessages: 2 });
  let generateCalls = 0;
  const generate = async () => {
    generateCalls++;
    return textResult(`Message ${generateCalls}.`);
  };

  await runOneTurn(runtime, { generate }); // 1
  await runOneTurn(runtime, { generate }); // 2 -- due for a checkpoint next
  assert.equal(generateCalls, 2);

  const third = await runOneTurn(runtime, { generate });
  assert.equal(third.outcome, "checkpoint");
  assert.equal(generateCalls, 2); // unchanged -- checkpoints are locally formatted, no OpenAI call

  const view = await runtime.client.readRoom("d-testroom");
  assert.match(view.messages[2].text, /DEBATE CHECKPOINT #1/);

  const state = loadState(runtime.config.statePath, "d-testroom");
  assert.equal(state.checkpointCount, 1);
  assert.equal(state.messagesSinceCheckpoint, 0);
});

test("checkpoint: still gated by the daily message limit like any other message -- a due checkpoint is not published once the day's budget is spent", async () => {
  const runtime = buildTestRuntime({ checkpointEnabled: true, checkpointEveryMessages: 1, maxMessagesPerDay: 1 });

  const first = await runOneTurn(runtime, { generate: async () => textResult("Opening message.") });
  assert.equal(first.outcome, "published"); // messagesSinceCheckpoint was 0 -- not yet due

  // Now messagesSinceCheckpoint=1 (>= threshold 1, checkpoint IS due), but the
  // day's 1-message budget is already spent -- the daily gate runs first.
  const second = await runOneTurn(runtime, { generate: async () => textResult("unused") });
  assert.equal(second.outcome, "daily-limit");

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 1); // no checkpoint slipped through
});

// -- repetition -> regenerate once -> skip -----------------------------------

test("repetition: a candidate too similar to recent own messages triggers exactly one regeneration, then SKIP if still too similar", async () => {
  const server = new FakeTechnocoreServer();
  const runtime = buildTestRuntime({ server });

  const priorMessage = "Real Madrid have won fifteen European Cups and that settles the entire argument completely.";
  server.seedMessage("d-testroom", runtime.agentA.did, priorMessage, 1);
  server.seedMessage("d-testroom", runtime.agentB.did, "Sure, but trophies alone don't decide greatest club.", 2);

  let generateCalls = 0;
  const result = await runOneTurn(runtime, {
    generate: async () => {
      generateCalls++;
      // Always returns something near-identical to Agent A's own prior message.
      return textResult("Real Madrid have won fifteen European Cups and that settles the entire argument completely, again.");
    },
  });

  assert.equal(generateCalls, 2); // one regeneration attempt, no more
  assert.equal(result.outcome, "skipped");

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 2); // only the two seeded messages -- nothing new published
});

// Regression: a real deployment saw Agent B post a message byte-for-byte
// identical to Agent A's immediately preceding message. The repetition check
// only ever compared a candidate against the SAME speaker's own history
// (`t.agentId === speakerId`), so Agent B copying Agent A verbatim was never
// caught -- this is the cross-speaker case the single-speaker test above
// doesn't cover.
test("repetition: a candidate that verbatim-copies the OPPONENT's just-posted message is also flagged, not just self-repetition", async () => {
  const server = new FakeTechnocoreServer();
  const runtime = buildTestRuntime({ server });

  const opponentsMessage = "The Melania coin scandal proves controversial memecoins are legitimate cultural events, not just hype.";
  server.seedMessage("d-testroom", runtime.agentA.did, opponentsMessage, 1); // next speaker is B

  let generateCalls = 0;
  const result = await runOneTurn(runtime, {
    generate: async () => {
      generateCalls++;
      // Agent B's "candidate" is an exact copy of what Agent A just said.
      return textResult(opponentsMessage);
    },
  });

  assert.equal(generateCalls, 2); // one regeneration attempt, no more
  assert.equal(result.outcome, "skipped");

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 1); // only Agent A's seeded message -- the copy never got published
});

// Regression: a real deployment reused an existing room for a brand-new topic
// (couldn't create a new one). The model kept anchoring on the OLD topic's
// history, and the repetition check kept comparing fresh replies against it
// too -- flagging every single attempt as a duplicate of a debate about
// something else entirely, forever. Fixed via `topicStartedAt`: turns before
// the cutoff are excluded from turn order, conversation context, AND the
// repetition check. This test is the SAME near-identical-content setup as the
// "repetition" test above (which correctly still skips without a cutoff) --
// the only difference is topicStartedAt, and here it must NOT skip.
test("topicStartedAt: a candidate matching pre-cutoff history is NOT flagged as repetitive once topicStartedAt excludes that history", async () => {
  const server = new FakeTechnocoreServer();
  const runtime = buildTestRuntime({ server });

  server.seedMessage("d-testroom", runtime.agentA.did, "Real Madrid have won fifteen European Cups and that settles the entire argument completely.", 1);
  server.seedMessage("d-testroom", runtime.agentB.did, "Sure, but trophies alone don't decide greatest club.", 2);

  await sleep(5); // ensure a strictly-later timestamp than the seeded messages
  runtime.definition.topicStartedAt = new Date().toISOString();

  let generateCalls = 0;
  const result = await runOneTurn(runtime, {
    generate: async () => {
      generateCalls++;
      // Same near-identical text as the un-cut-off test above -- would be
      // flagged as repetitive if the old messages were still visible.
      return textResult("Real Madrid have won fifteen European Cups and that settles the entire argument completely, again.");
    },
  });

  assert.equal(generateCalls, 1); // no regeneration needed -- passed on the first attempt
  assert.equal(result.outcome, "published");

  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 3); // the two old (untouched) messages plus the new one
});

test("topicStartedAt: turn order and conversation context ignore everything posted before the cutoff", async () => {
  const server = new FakeTechnocoreServer();
  const runtime = buildTestRuntime({ server });

  // Agent A spoke last before the cutoff -- without topicStartedAt, Agent B
  // would go next. With it, the room looks empty past the cutoff, so Agent A
  // (whose own old message this even is) speaks first, exactly like an
  // actually-empty room.
  server.seedMessage("d-testroom", runtime.agentA.did, "OLD TOPIC: FC Barcelona's tiki-taka changed football forever.", 1);
  await sleep(5);
  runtime.definition.topicStartedAt = new Date().toISOString();

  const result = await runOneTurn(runtime, { generate: async () => textResult("NEW TOPIC: opening argument about memecoins.") });

  assert.equal(result.speakerId, "A"); // NOT "B" -- the pre-cutoff message doesn't count
  const view = await runtime.client.readRoom("d-testroom");
  assert.equal(view.count, 2);
  assert.equal(view.messages[1].text, "NEW TOPIC: opening argument about memecoins.");
});

test("runOneTurn: a configured rotationTopics is threaded through to the model input as a mandatory focus", async () => {
  const runtime = buildTestRuntime({ rotationTopics: ["Dogecoin", "Pepe"], rotationEveryMessages: 4 });

  let capturedInput = "";
  await runOneTurn(runtime, {
    generate: async (params) => {
      capturedInput = params.input;
      return textResult("Opening argument.");
    },
  });

  assert.match(capturedInput, /FOCUS FOR THIS MESSAGE \(mandatory, not a suggestion\): Dogecoin\./);
});

test("runOneTurn: without rotationTopics configured, no forced-focus instruction appears at all", async () => {
  const runtime = buildTestRuntime(); // no rotationTopics override

  let capturedInput = "";
  await runOneTurn(runtime, {
    generate: async (params) => {
      capturedInput = params.input;
      return textResult("Opening argument.");
    },
  });

  assert.doesNotMatch(capturedInput, /FOCUS FOR THIS MESSAGE/);
});

test("repetition: a regeneration that comes back sufficiently different DOES get published", async () => {
  const server = new FakeTechnocoreServer();
  const runtime = buildTestRuntime({ server });
  server.seedMessage("d-testroom", runtime.agentA.did, "Real Madrid have won fifteen European Cups and that settles the entire argument completely.", 1);
  server.seedMessage("d-testroom", runtime.agentB.did, "Sure, but trophies alone don't decide greatest club.", 2);

  let generateCalls = 0;
  const result = await runOneTurn(runtime, {
    generate: async () => {
      generateCalls++;
      if (generateCalls === 1) {
        return textResult("Real Madrid have won fifteen European Cups and that settles the entire argument completely.");
      }
      return textResult("La Masia produced more Ballon d'Or level talent than any academy in the sport's history.");
    },
  });

  assert.equal(generateCalls, 2);
  assert.equal(result.outcome, "published");
});
