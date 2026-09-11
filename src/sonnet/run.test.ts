import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { pollOnce, runLoop } from "./run.js";
import { defaultState } from "./state.js";
import { loadSonnetConfig, type ContestConfig, type SonnetConfig } from "./config.js";
import type { SonnetAgentIdentity } from "./identity.js";

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

function makeAgent(): SonnetAgentIdentity {
  const identity = makeTestIdentity();
  return { identity, did: identity.did, identityPath: "test" };
}

test("pollOnce: never posts anything, even with pending interests and a team request", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  let posted = false;
  const spyingClient = new TechnocoreClient({
    fetchImpl: async (input, init) => {
      if (init?.method === "POST") posted = true;
      return server.fetch(input, init);
    },
  });

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "TEAM_REQUESTED" as const,
    team: { gameId: "a", requestId: "r-1", requestedAtUtc: "2026-09-11T13:00:00Z" },
    pendingJoinInterests: [{ gameId: "b", requesterDid: makeTestIdentity().did, sentAtUtc: "2026-09-11T13:00:00Z" }],
  };

  await pollOnce(agent, CONTEST, config, state, spyingClient);
  assert.equal(posted, false);
});

test("pollOnce: reconciles an already-accepted registration observed in the room into a fresh/empty local state", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned(
    "mb-sonnet-1-registration",
    agent.identity,
    JSON.stringify({ type: "sonnet.register.v1", contest_id: "sonnet-1", role: "writer", x_account_url: "https://x.com/us", request_id: "register-1" }),
  );

  const state = defaultState("sonnet-1", agent.did); // phase UNREGISTERED, no registration
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.registration?.role, "writer");
  assert.equal(next.registration?.xAccountUrl, "https://x.com/us");
  assert.equal(next.phase, "DISCOVERING"); // both REGISTERED and DISCOVERING transitions applied in one tick
});

test("pollOnce: does not overwrite an already-recorded local registration", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned(
    "mb-sonnet-1-registration",
    agent.identity,
    JSON.stringify({ type: "sonnet.register.v1", contest_id: "sonnet-1", role: "writer", x_account_url: "https://x.com/us", request_id: "register-1" }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "DISCOVERING" as const,
    registration: { role: "writer" as const, requestId: "already-local", confirmedSeq: 42 },
  };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.registration?.requestId, "already-local");
});

test("pollOnce: reconciles our own team-request observed in the room into a fresh/empty local state", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned(
    "mb-sonnet-1-discovery",
    agent.identity,
    JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "satoshitrump", request_id: "team-1" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), phase: "DISCOVERING" as const };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.team?.gameId, "satoshitrump");
  assert.equal(next.phase, "TEAM_REQUESTED");
});

test("pollOnce: does not overwrite an already-recorded local team-request", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned(
    "mb-sonnet-1-discovery",
    agent.identity,
    JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "satoshitrump", request_id: "team-1" }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "TEAM_REQUESTED" as const,
    team: { gameId: "already-local", requestId: "local-req", requestedAtUtc: "2026-09-11T13:00:00Z" },
  };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.team?.gameId, "already-local");
});

test("pollOnce: detects when our own requested room becomes set up and advances the phase", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const referee = makeTestIdentity();
  server.postSigned("d-sonnet-1-team-a", referee, "room claimed");

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "TEAM_REQUESTED" as const,
    team: { gameId: "a", requestId: "r-1", requestedAtUtc: "2026-09-11T13:00:00Z" },
  };

  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.team?.roomGeneration, 0);
  assert.equal(next.phase, "ROOM_ASSIGNED");
  assert.deepEqual(tick.newlySetUpRooms, ["a"]);
});

test("pollOnce: detects when a pending join-interest's room becomes set up, without re-checking an already-detected one", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const requester = makeTestIdentity();
  server.postSigned("d-sonnet-1-team-flop-bard-1", requester, "room claimed");

  const state = {
    ...defaultState("sonnet-1", agent.did),
    pendingJoinInterests: [
      { gameId: "flop-bard-1", requesterDid: requester.did, sentAtUtc: "2026-09-11T13:00:00Z" },
      { gameId: "keeper1", requesterDid: requester.did, sentAtUtc: "2026-09-11T13:00:00Z" },
    ],
  };

  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.deepEqual(tick.newlySetUpRooms, ["flop-bard-1"]);
  assert.ok(next.pendingJoinInterests?.find((i) => i.gameId === "flop-bard-1")?.roomSetUpAtUtc);
  assert.equal(next.pendingJoinInterests?.find((i) => i.gameId === "keeper1")?.roomSetUpAtUtc, undefined);
});

test("runLoop: exits immediately without polling when SONNET_ENABLED is false", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), enabled: false };
  let calls = 0;
  await runLoop(agent, CONTEST, config, "unused-path", () => {
    calls++;
    return defaultState("sonnet-1", agent.did);
  });
  assert.equal(calls, 0);
});

test("runLoop: runs exactly one tick then stops when shouldStop is already true, with no real disk/network I/O", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), enabled: true, pollIntervalMs: 1, actionJitterMs: 0 };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  let loadCalls = 0;
  let sleepCalls = 0;
  let saveCalls = 0;
  await runLoop(
    agent,
    CONTEST,
    config,
    "unused-path",
    () => {
      loadCalls++;
      return defaultState("sonnet-1", agent.did);
    },
    { shouldStop: () => true, sleep: async () => { sleepCalls++; }, client, saveState: () => { saveCalls++; } },
  );
  assert.equal(loadCalls, 1);
  assert.equal(sleepCalls, 0);
  assert.equal(saveCalls, 1);
});
