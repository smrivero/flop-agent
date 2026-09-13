import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { buildProposePreview, proposeWord, ProposeError } from "./propose.js";
import { loadSonnetConfig, type ContestConfig, type SonnetConfig } from "./config.js";
import type { Lexicon } from "./cmudict.js";
import type { RhymeIndex } from "./rhyme.js";
import type { TechnocoreIdentity } from "../identity.js";

const CONTEST: ContestConfig = {
  contest_id: "sonnet-1",
  rules_version: "0.5",
  opening: "2026-09-11T12:00:00Z",
  deadline: "2026-09-18T12:00:00Z",
  prize: 50000,
  voter_pool: 50000,
  payment_unit: "FLOP",
  payment_method: "x",
  theme: null,
  identity_policy: "verified-prestart-did",
  identity_cutoff: "2026-09-11T12:00:00Z",
};

// A tiny lexicon covering exactly the words this suite needs. Deliberately
// spelled using ONLY letters guaranteed present in any did:key: DID (the
// literal "did:key:" prefix itself supplies d/i/k/e/y) -- these tests use
// freshly-generated random test identities, so a real word like "sky" would
// only be a legal candidate for a subset of possible random DIDs.
const LEXICON: Lexicon = new Map([
  ["key", 1],
  ["eyed", 1],
  ["deed", 1],
]);
const EMPTY_RHYME_INDEX: RhymeIndex = new Map();

async function withMockFetch<T>(response: Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function llmResponse(word: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ word, reason: "test", confidence: 0.5 }) } }] }), { status: 200 });
}

function baseConfig(overrides: Partial<SonnetConfig> = {}): SonnetConfig {
  return { ...loadSonnetConfig({}), openAiApiKey: "sk-test", openAiModel: "gpt-test", ...overrides };
}

async function setUpRoom(server: FakeTechnocore, gameId: string, referee: TechnocoreIdentity): Promise<void> {
  server.postSigned(`d-sonnet-1-team-${gameId}`, referee, "room claimed, generation 0");
}

test("buildProposePreview: happy path on an empty poem produces a verified, unsent preview", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);

  const config = baseConfig();
  const preview = await withMockFetch(llmResponse("key"), () =>
    buildProposePreview(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
  );

  assert.equal(preview.planned.word, "key");
  assert.equal(preview.payload.word, "key");
  assert.equal(preview.payload.game_id, "a");
  assert.equal(preview.verifiedLocally, true);
  assert.equal(preview.room, "d-sonnet-1-team-a");
});

test("buildProposePreview: follows an active coordinator plan instead of calling the LLM, when the plan's word for our position is legal", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);
  server.postSigned(
    "d-sonnet-1-team-a",
    other,
    JSON.stringify({ type: "sonnet.note.v1", contest_id: "sonnet-1", game_id: "a", room_generation: 0, request_id: "plan-1", poem: "Key eyed" }),
  );

  const config = baseConfig();
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("LLM should never be called when a legal plan word exists");
  }) as typeof fetch;
  let preview;
  try {
    preview = await buildProposePreview(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetchCalled, false);
  assert.equal(preview.planned.word, "Key"); // original casing from the plan, preserved
  assert.equal(preview.payload.word, "Key");
});

test("buildProposePreview: ignores a coordinator plan word that isn't mechanically legal, falls back to the LLM", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);
  // Plan's word at position 0 is "banana" -- not in our tiny LEXICON at all.
  server.postSigned(
    "d-sonnet-1-team-a",
    other,
    JSON.stringify({ type: "sonnet.note.v1", contest_id: "sonnet-1", game_id: "a", room_generation: 0, request_id: "plan-1", poem: "banana eyed" }),
  );

  const config = baseConfig();
  const preview = await withMockFetch(llmResponse("key"), () =>
    buildProposePreview(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
  );
  assert.equal(preview.planned.word, "key"); // fell back to the (mocked) LLM choice
});

test("buildProposePreview: refuses when we were the previous contributor", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);

  // Seed one accepted word from US, so previousContributorDid === us.did.
  server.postSigned("d-sonnet-1-team-a", us, JSON.stringify({ type: "sonnet.word.v1", contest_id: "sonnet-1", game_id: "a", room_generation: 0, version: 0, previous_state_hash: "", word: "eyed", request_id: "r-1" }));
  server.postSigned("d-sonnet-1-team-a", referee, JSON.stringify({ request_id: "r-1", state_hash: "h1", version: 1 }));

  const config = baseConfig();
  await assert.rejects(
    () => buildProposePreview(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
    ProposeError,
  );
});

test("buildProposePreview: refuses when the team room isn't set up yet", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  // No setUpRoom call -- room stays empty.

  const config = baseConfig();
  await assert.rejects(
    () => buildProposePreview(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
    ProposeError,
  );
});

test("buildProposePreview: requires OPENAI_API_KEY/OPENAI_MODEL", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);

  const config = baseConfig({ openAiApiKey: undefined });
  await assert.rejects(
    () => buildProposePreview(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
    ProposeError,
  );
});

test("proposeWord: dry-run never touches the network for the actual post", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);

  const config = baseConfig({ dryRun: true });
  const result = await withMockFetch(llmResponse("key"), () =>
    proposeWord(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
  );
  assert.equal(result.sent, false);

  const room = await client.readRoom("d-sonnet-1-team-a", { since: 0 });
  assert.equal(room.messages.some((m) => m.from === us.did), false);
});

test("proposeWord: real path sends and confirms via independent read-back", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);

  const config = baseConfig({ dryRun: false });
  const result = await withMockFetch(llmResponse("key"), () =>
    proposeWord(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
  );
  assert.equal(result.sent, true);
  assert.ok(typeof result.postedSeq === "number");

  const room = await client.readRoom("d-sonnet-1-team-a", { since: 0 });
  const ours = room.messages.find((m) => m.from === us.did);
  assert.ok(ours);
  assert.equal(JSON.parse(ours!.text).word, "key");
});

test("proposeWord: refuses to send when the state changed since the preview was built", async () => {
  const us = makeTestIdentity();
  const other = makeTestIdentity();
  const referee = makeTestIdentity();
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  await setUpRoom(server, "a", referee);

  const config = baseConfig({ dryRun: false });

  // A version of fetch that, on its FIRST OpenAI call, also slips in a
  // competing accepted word into the room -- simulating someone else's
  // proposal landing while our LLM call was in flight.
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args) => {
    server.postSigned("d-sonnet-1-team-a", other, JSON.stringify({ type: "sonnet.word.v1", contest_id: "sonnet-1", game_id: "a", room_generation: 0, version: 0, previous_state_hash: "", word: "eyed", request_id: "race-1" }));
    server.postSigned("d-sonnet-1-team-a", referee, JSON.stringify({ request_id: "race-1", state_hash: "race-hash", version: 1 }));
    return llmResponse("key");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => proposeWord(us, CONTEST, config, { gameId: "a", rosterMembers: [us.did, other.did], lexicon: LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }, client),
      ProposeError,
    );
  } finally {
    globalThis.fetch = original;
  }

  // And critically: nothing from US was ever posted.
  const room = await client.readRoom("d-sonnet-1-team-a", { since: 0 });
  assert.equal(room.messages.some((m) => m.from === us.did), false);
});
