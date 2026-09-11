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

test("pollOnce: detects being ACCEPTED into someone else's roster (our DID appears in a roster.v1 for that game_id)", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const requester = makeTestIdentity();
  server.postSigned(
    "mb-sonnet-1-discovery",
    requester,
    JSON.stringify({
      type: "sonnet.roster.v1",
      contest_id: "sonnet-1",
      game_id: "flop-bard-1",
      poem_room: "d-sonnet-1-team-flop-bard-1",
      room_generation: 0,
      members: [requester.did, agent.did],
      request_id: "roster-1",
    }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    pendingJoinInterests: [{ gameId: "flop-bard-1", requesterDid: requester.did, sentAtUtc: "2026-09-11T13:00:00Z" }],
  };

  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.deepEqual(tick.newlyAcceptedIntoTeams, ["flop-bard-1"]);
  assert.ok(next.pendingJoinInterests?.find((i) => i.gameId === "flop-bard-1")?.acceptedAtUtc);
});

test("pollOnce: a roster.v1 for the same game_id NOT including us is not reported as acceptance", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const requester = makeTestIdentity();
  const someoneElse = makeTestIdentity();
  server.postSigned(
    "mb-sonnet-1-discovery",
    requester,
    JSON.stringify({
      type: "sonnet.roster.v1",
      contest_id: "sonnet-1",
      game_id: "flop-bard-1",
      poem_room: "d-sonnet-1-team-flop-bard-1",
      room_generation: 0,
      members: [requester.did, someoneElse.did],
      request_id: "roster-1",
    }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    pendingJoinInterests: [{ gameId: "flop-bard-1", requesterDid: requester.did, sentAtUtc: "2026-09-11T13:00:00Z" }],
  };

  const { tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.deepEqual(tick.newlyAcceptedIntoTeams, []);
});

test("pollOnce: announces a new roster.v1 proposal for OUR OWN game_id exactly once", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const joiner = makeTestIdentity();
  server.postSigned(
    "mb-sonnet-1-discovery",
    joiner,
    JSON.stringify({
      type: "sonnet.roster.v1",
      contest_id: "sonnet-1",
      game_id: "satoshitrump",
      poem_room: "d-sonnet-1-team-satoshitrump",
      room_generation: 0,
      members: [agent.did, joiner.did],
      request_id: "roster-1",
    }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    team: { gameId: "satoshitrump", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" },
  };

  const first = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(first.tick.newRosterProposalsForOwnTeam.length, 1);
  assert.equal(first.tick.newRosterProposalsForOwnTeam[0].did, joiner.did);

  // A second tick against the same (still-persisted) state must not re-announce it.
  const second = await pollOnce(agent, CONTEST, config, first.state, client);
  assert.equal(second.tick.newRosterProposalsForOwnTeam.length, 0);
});

test("pollOnce: SONNET_AUTO_TEAM disabled (default) never signs, even with a perfectly valid candidate roster", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({}); // autoTeam defaults false
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const members = [agent.did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];

  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "satoshitrump", poem_room: "d-sonnet-1-team-satoshitrump", room_generation: 0, members, request_id: "roster-1" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), team: { gameId: "satoshitrump", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" } };
  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.roster, undefined);
  assert.equal(tick.autoSignedRoster, undefined);
});

test("pollOnce: SONNET_AUTO_TEAM=true + SONNET_DRY_RUN=true previews but never signs or marks the candidate attempted", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoTeam: true, dryRun: true };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const members = [agent.did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];

  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "satoshitrump", poem_room: "d-sonnet-1-team-satoshitrump", room_generation: 0, members, request_id: "roster-1" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), team: { gameId: "satoshitrump", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" } };
  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.roster, undefined);
  assert.equal(tick.autoSignedRoster, undefined);
  assert.deepEqual(next.autoSignAttemptedRequestIds ?? [], []);
});

test("pollOnce: SONNET_AUTO_TEAM=true + SONNET_DRY_RUN=false signs a valid observed roster for real", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoTeam: true, dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const members = [agent.did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];

  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "satoshitrump", poem_room: "d-sonnet-1-team-satoshitrump", room_generation: 0, members, request_id: "roster-1" }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "ROOM_ASSIGNED" as const,
    team: { gameId: "satoshitrump", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" },
  };
  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.deepEqual(next.roster?.members, members);
  assert.equal(next.roster?.gameId, "satoshitrump");
  assert.equal(next.phase, "ROSTER_PENDING");
  assert.equal(tick.autoSignedRoster?.gameId, "satoshitrump");

  // The signed roster is actually on the wire, not just local state.
  const room = await client.readRoom("mb-sonnet-1-discovery", { since: 0 });
  const ours = room.messages.find((m) => m.from === agent.did && JSON.parse(m.text).type === "sonnet.roster.v1");
  assert.ok(ours);
});

test("pollOnce: SONNET_AUTO_TEAM never signs a second roster once one is already signed this contest", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoTeam: true, dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const members = [agent.did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];

  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "flop-bard-1", poem_room: "d-sonnet-1-team-flop-bard-1", room_generation: 0, members, request_id: "roster-x" }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    roster: { members: ["already", "signed"], requestId: "prior", signedAtUtc: "2026-09-11T13:00:00Z", gameId: "keeper1" },
    pendingJoinInterests: [{ gameId: "flop-bard-1", requesterDid: makeTestIdentity().did, sentAtUtc: "2026-09-11T13:00:00Z" }],
  };
  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.roster?.gameId, "keeper1"); // unchanged
  assert.equal(tick.autoSignedRoster, undefined);
});

test("pollOnce: SONNET_AUTO_TEAM does not sign a roster whose member count is outside 4-8", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoTeam: true, dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const tooFew = [agent.did, makeTestIdentity().did]; // only 2

  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "satoshitrump", poem_room: "d-sonnet-1-team-satoshitrump", room_generation: 0, members: tooFew, request_id: "roster-1" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), team: { gameId: "satoshitrump", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" } };
  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(next.roster, undefined);
  assert.equal(tick.autoSignedRoster, undefined);
});

test("pollOnce: SONNET_AUTO_TEAM never retries a conflicting candidate it already attempted", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoTeam: true, dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  // Our only candidate (includes us, valid 4-member count)...
  const ourCandidate = [agent.did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];
  // ...conflicts with a DIFFERENT members list someone else proposed for the
  // same game_id, that does NOT include us (so it's never itself a candidate,
  // there's exactly one thing to ever attempt-and-fail here).
  const conflicting = [makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];

  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "satoshitrump", poem_room: "x", room_generation: 0, members: ourCandidate, request_id: "roster-a" }),
  );
  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "satoshitrump", poem_room: "x", room_generation: 0, members: conflicting, request_id: "roster-b" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), team: { gameId: "satoshitrump", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" } };
  const first = await pollOnce(agent, CONTEST, config, state, client);
  assert.equal(first.state.roster, undefined);
  assert.deepEqual(first.state.autoSignAttemptedRequestIds, ["roster-a"]);

  const second = await pollOnce(agent, CONTEST, config, first.state, client);
  assert.deepEqual(second.state.autoSignAttemptedRequestIds, ["roster-a"]); // no new attempt
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
