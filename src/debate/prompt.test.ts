import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAIMS_DELIMITER } from "./claims.js";
import { buildInput, buildInstructions } from "./prompt.js";
import type { DebateDefinition, DebateState, LoadedAgent } from "./types.js";

function testAgent(): LoadedAgent {
  return {
    id: "A",
    name: "cules-ai",
    position: "FC Barcelona is the greatest club",
    opponentName: "madridista-ai",
    opponentPosition: "Real Madrid is the greatest club",
    personality: "You are a die-hard Barcelona supporter.",
    did: "did:key:z6MkTest",
    sign: () => "sig",
  };
}

function testDefinition(): DebateDefinition {
  return {
    room: "d-elclasico",
    topic: "Which club is greatest",
    language: "English",
    agentA: { name: "cules-ai", position: "p", personalityFile: "unused" },
    agentB: { name: "madridista-ai", position: "p", personalityFile: "unused" },
  };
}

function testState(): DebateState {
  return {
    room: "d-elclasico",
    lastProcessedSeq: 0,
    lastSpeakerDid: null,
    totalMessages: 0,
    recentTopics: [],
    recentClaims: [],
    recentSources: [],
    currentDay: "2026-09-01",
    messagesToday: 0,
    claimRecords: [],
    claimStats: { verified: 0, disputed: 0, corrected: 0 },
    claimCounter: 0,
    messagesSinceCheckpoint: 0,
    checkpointCount: 0,
    lastArchiveAt: null,
    lastIdentityRefreshA: null,
    lastIdentityRefreshB: null,
    updatedAt: new Date().toISOString(),
  };
}

test("buildInstructions: includes the personality verbatim", () => {
  const instructions = buildInstructions(testAgent(), testDefinition(), true);
  assert.ok(instructions.includes("You are a die-hard Barcelona supporter."));
});

test("buildInstructions: tells the model it may return exactly SKIP", () => {
  const instructions = buildInstructions(testAgent(), testDefinition(), true);
  assert.match(instructions, /\bSKIP\b/);
  assert.match(instructions, /nothing new or useful/i);
});

test("buildInstructions: asks for the claims trailer using the shared delimiter constant", () => {
  const instructions = buildInstructions(testAgent(), testDefinition(), true);
  assert.ok(instructions.includes(CLAIMS_DELIMITER));
});

test("buildInstructions: current UTC date is injected dynamically, not hardcoded", () => {
  const instructions = buildInstructions(testAgent(), testDefinition(), true);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(instructions.includes(`CURRENT DATE: ${today}`));
});

test("buildInstructions: source-preference guidance is general (field-appropriate), not hardcoded to football domains in application logic", () => {
  const instructions = buildInstructions(testAgent(), testDefinition(), true);
  // The prompt may still name football sources as an EXAMPLE (it does, by design),
  // but must also state the general, subject-agnostic principle for other topics.
  assert.match(instructions, /crypto|AI|economics|technology|science/);
});

// Regression: this line used to unconditionally say "This is a football
// forum, not a newspaper and not an academic debate" regardless of
// `definition.topic` -- baked into `instructions`, which the module's own
// header comment says is "always highest priority". A real deployment
// changed topic+personality to a memecoin debate but kept generating
// football content, because the model was still being told, at max
// priority, that it was in a football forum. Fixed by making that sentence
// topic-agnostic; this locks it that way for any future topic.
test("buildInstructions: never hardcodes 'football forum' regardless of the configured topic", () => {
  const footballInstructions = buildInstructions(testAgent(), testDefinition(), true);
  assert.doesNotMatch(footballInstructions, /football forum/i);

  const memecoinDefinition: DebateDefinition = {
    room: "d-elclasico",
    topic: "Which controversial memecoins are legitimate",
    language: "English",
    agentA: { name: "memecoin-maxi-ai", position: "p", personalityFile: "unused" },
    agentB: { name: "memecoin-skeptic-ai", position: "p", personalityFile: "unused" },
  };
  const memecoinInstructions = buildInstructions(testAgent(), memecoinDefinition, true);
  assert.doesNotMatch(memecoinInstructions, /football/i);
});

test("buildInstructions: web search block is omitted entirely when webSearchEnabled=false", () => {
  const withSearch = buildInstructions(testAgent(), testDefinition(), true);
  const withoutSearch = buildInstructions(testAgent(), testDefinition(), false);
  assert.match(withSearch, /FACTUAL CLAIM POLICY/);
  assert.doesNotMatch(withoutSearch, /FACTUAL CLAIM POLICY/);
});

test("buildInput: an empty room produces an opening-message instruction, no 'recent conversation' section", () => {
  const input = buildInput(testAgent(), [], testState(), "SHORT", 3500);
  assert.match(input, /first message of the debate/i);
  assert.doesNotMatch(input, /Recent conversation/);
});

// Regression: the "overused topic" steering (shown once memory.recentClaims
// is non-empty) used to hardcode a list of FOOTBALL-specific angles
// ("domestic leagues", "Ballon d'Or winners", "Club World Cup", ...) as the
// suggested way to move on. A real deployment switched the debate to
// memecoins and kept restating the same story turn after turn -- the model
// had no usable steering once its one well-sourced story (the Melania coin
// scandal) got flagged as overused, since every suggested alternative angle
// was football-only and meaningless for this topic. Fixed by making the
// steering topic-agnostic; this locks it that way for any future topic.
test("buildInput: 'overused topic' steering never hardcodes football-specific angles, regardless of the configured topic", () => {
  const state = testState();
  state.recentClaims = ["Real Madrid have won fifteen European Cups"];
  const input = buildInput(testAgent(), [], state, "SHORT", 3500);
  assert.match(input, /RECENTLY OVERUSED TOPICS/);
  assert.doesNotMatch(input, /Ballon d'Or|Club World Cup|domestic leagues/i);
});

test("buildInput: a forcedTopic produces a mandatory-focus instruction naming it, and suppresses the generic 'overused topic' steering", () => {
  const state = testState();
  state.recentClaims = ["Some earlier claim about Dogecoin."];
  const input = buildInput(testAgent(), [], state, "SHORT", 3500, "Pepe");
  assert.match(input, /FOCUS FOR THIS MESSAGE \(mandatory, not a suggestion\): Pepe\./);
  assert.doesNotMatch(input, /RECENTLY OVERUSED TOPICS/);
  assert.match(input, /RECENT MESSAGES/); // still shown, just relabeled
});

test("buildInput: without a forcedTopic, the generic 'overused topic' steering still applies as before", () => {
  const state = testState();
  state.recentClaims = ["Some earlier claim."];
  const input = buildInput(testAgent(), [], state, "SHORT", 3500);
  assert.doesNotMatch(input, /FOCUS FOR THIS MESSAGE/);
  assert.match(input, /RECENTLY OVERUSED TOPICS/);
});

test("buildInput: a non-empty room includes the opponent's latest message for direct reply", () => {
  const state = testState();
  const turns = [
    { seq: 1, agentId: "A" as const, did: "did:key:z6MkA", text: "Opening for Barca.", ts: "" },
    { seq: 2, agentId: "B" as const, did: "did:key:z6MkB", text: "Real Madrid has more trophies.", ts: "" },
  ];
  const input = buildInput(testAgent(), turns, state, "SHORT", 3500);
  assert.match(input, /Opponent's latest message/);
  assert.match(input, /Real Madrid has more trophies\./);
});
