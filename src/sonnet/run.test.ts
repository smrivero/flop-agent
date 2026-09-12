import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { pollOnce, runLoop } from "./run.js";
import { defaultState } from "./state.js";
import { loadSonnetConfig, type ContestConfig, type SonnetConfig } from "./config.js";
import type { SonnetAgentIdentity } from "./identity.js";
import type { Lexicon } from "./cmudict.js";
import type { RhymeIndex } from "./rhyme.js";

// Deliberately spelled using ONLY letters guaranteed present in any
// did:key: DID (the literal "did:key:" prefix supplies d/i/k/e/y) -- these
// tests use freshly-generated random test identities, so a real word like
// "sky" would only be a legal candidate for a subset of possible random DIDs.
const WORD_LEXICON: Lexicon = new Map([
  ["key", 1],
  ["eyed", 1],
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

test("pollOnce: does NOT mark a registration confirmed just because our own post landed -- only a receipt does", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned(
    "mb-sonnet-1-registration",
    agent.identity,
    JSON.stringify({ type: "sonnet.register.v1", contest_id: "sonnet-1", role: "writer", request_id: "register-1" }),
  );
  // No receipt posted yet -- the referee hasn't gotten to it.

  const { state: next } = await pollOnce(agent, CONTEST, config, defaultState("sonnet-1", agent.did), client);
  assert.equal(next.registration?.requestId, "register-1");
  assert.equal(next.registration?.confirmedAtUtc, undefined);
  assert.equal(next.registration?.rejectedAtUtc, undefined);
});

test("pollOnce: confirms a registration once the referee's accepted receipt is observed", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const referee = makeTestIdentity();

  server.postSigned(
    "mb-sonnet-1-registration",
    referee,
    JSON.stringify({ type: "sonnet.receipt.v1", contest_id: "sonnet-1", request_id: "register-1", sender_did: agent.did, status: "accepted", reason: "" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), registration: { role: "writer" as const, requestId: "register-1" } };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);
  assert.ok(next.registration?.confirmedAtUtc);
  assert.equal(typeof next.registration?.confirmedSeq, "number");
  assert.equal(next.registration?.rejectedAtUtc, undefined);
});

test("pollOnce: marks a registration REJECTED once the referee's rejection receipt is observed, and never confirms it", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const referee = makeTestIdentity();

  server.postSigned(
    "mb-sonnet-1-registration",
    referee,
    JSON.stringify({ type: "sonnet.receipt.v1", contest_id: "sonnet-1", request_id: "register-1", sender_did: agent.did, status: "rejected", reason: "room request: writer or organizer" }),
  );

  const state = { ...defaultState("sonnet-1", agent.did), registration: { role: "writer" as const, requestId: "register-1" } };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);
  assert.ok(next.registration?.rejectedAtUtc);
  assert.equal(next.registration?.rejectedReason, "room request: writer or organizer");
  assert.equal(next.registration?.confirmedAtUtc, undefined);
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

test("pollOnce: drops a REJECTED team-request from active tracking into deadTeamRequests, and stops polling its room", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const referee = makeTestIdentity();
  let roomSetupChecks = 0;
  const client = new TechnocoreClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/team-dead/export")) roomSetupChecks++;
      return server.fetch(input, init);
    },
  });

  server.postSigned(
    "mb-sonnet-1-discovery",
    referee,
    JSON.stringify({
      type: "sonnet.receipts.v1",
      contest_id: "sonnet-1",
      status: "rejected",
      reason: "room request: writer or organizer",
      receipts: [{ request_id: "team-dead-req", sender_did: agent.did }],
    }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "TEAM_REQUESTED" as const,
    team: { gameId: "team-dead", requestId: "team-dead-req", requestedAtUtc: "2026-09-11T13:00:00Z" },
  };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.team, undefined);
  assert.equal(next.additionalTeamRequests?.length ?? 0, 0);
  assert.equal(next.deadTeamRequests?.length, 1);
  assert.equal(next.deadTeamRequests?.[0].gameId, "team-dead");
  assert.equal(next.deadTeamRequests?.[0].reason, "room request: writer or organizer");
  assert.equal(roomSetupChecks, 0); // never even checked room setup for a game_id we already know is dead
});

test("pollOnce: a REJECTED team-request already in deadTeamRequests is never resurrected or re-logged on a later tick", async () => {
  // Regression test for a real bug: our OWN team-request message never
  // disappears from the room (we sent it), so the "observed untracked
  // team-request" self-healing block would see it again on the very next
  // tick after it was dropped, re-add it to team/additionalTeamRequests,
  // and the rejection-handling block would then re-detect and re-append it
  // to deadTeamRequests -- forever, once per tick, spamming [SONNET][TEAM]
  // REJECTED and growing deadTeamRequests without bound.
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const referee = makeTestIdentity();

  await server.postSigned(
    "mb-sonnet-1-discovery",
    agent.identity,
    JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "team-dead", request_id: "team-dead-req" }),
  );
  await server.postSigned(
    "mb-sonnet-1-discovery",
    referee,
    JSON.stringify({
      type: "sonnet.receipts.v1",
      contest_id: "sonnet-1",
      status: "rejected",
      reason: "room request: writer or organizer",
      receipts: [{ request_id: "team-dead-req", sender_did: agent.did }],
    }),
  );

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  // Starting state already reflects a PRIOR tick's correct handling: the
  // request was already dropped into deadTeamRequests and is no longer in
  // team/additionalTeamRequests -- but the message is still sitting in the
  // room, exactly like production.
  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "DISCOVERING" as const,
    deadTeamRequests: [{ gameId: "team-dead", requestId: "team-dead-req", requestedAtUtc: "2026-09-11T13:00:00Z", rejectedAtUtc: "2026-09-11T17:00:00Z", reason: "room request: writer or organizer" }],
  };

  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.team, undefined); // never resurrected
  assert.equal(next.additionalTeamRequests?.length ?? 0, 0);
  assert.equal(next.deadTeamRequests?.length, 1); // not duplicated
  assert.equal(next.phase, "DISCOVERING"); // never transitions to TEAM_REQUESTED for a dead request
});

test("pollOnce: a hedge team-request that's still pending survives when a DIFFERENT one is rejected", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const referee = makeTestIdentity();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned(
    "mb-sonnet-1-discovery",
    referee,
    JSON.stringify({
      type: "sonnet.receipt.v1",
      contest_id: "sonnet-1",
      request_id: "req-a",
      sender_did: agent.did,
      status: "rejected",
      reason: "room request: writer or organizer",
    }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "TEAM_REQUESTED" as const,
    team: { gameId: "game-a", requestId: "req-a", requestedAtUtc: "2026-09-11T13:00:00Z" },
    additionalTeamRequests: [{ gameId: "game-b", requestId: "req-b", requestedAtUtc: "2026-09-11T13:00:01Z" }],
  };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.team?.gameId, "game-b"); // the survivor is promoted to primary
  assert.equal(next.additionalTeamRequests?.length ?? 0, 0);
  assert.equal(next.deadTeamRequests?.[0].gameId, "game-a");
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

test("pollOnce: SONNET_AUTO_WRITE disabled (default) never proposes, even with a locked roster whose turn it is", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoWrite: false, openAiApiKey: "sk-test", openAiModel: "gpt-test" };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const referee = makeTestIdentity();
  server.postSigned("d-sonnet-1-team-satoshitrump", referee, "room claimed, generation 0");

  const state = {
    ...defaultState("sonnet-1", agent.did),
    roster: { members: [agent.did, makeTestIdentity().did], requestId: "roster-1", signedAtUtc: "2026-09-11T13:00:00Z", gameId: "satoshitrump" },
  };
  const { tick } = await withMockFetch(llmResponse("key"), () => pollOnce(agent, CONTEST, config, state, client, { lexicon: WORD_LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }));
  assert.equal(tick.autoProposedWord, undefined);
  const room = await client.readRoom("d-sonnet-1-team-satoshitrump", { since: 0 });
  assert.equal(room.messages.some((m) => m.from === agent.did), false);
});

test("pollOnce: SONNET_AUTO_WRITE=true proposes and sends when it's genuinely our turn", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoWrite: true, dryRun: false, openAiApiKey: "sk-test", openAiModel: "gpt-test" };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const referee = makeTestIdentity();
  server.postSigned("d-sonnet-1-team-satoshitrump", referee, "room claimed, generation 0");

  const state = {
    ...defaultState("sonnet-1", agent.did),
    roster: { members: [agent.did, makeTestIdentity().did], requestId: "roster-1", signedAtUtc: "2026-09-11T13:00:00Z", gameId: "satoshitrump" },
  };
  const { tick } = await withMockFetch(llmResponse("key"), () => pollOnce(agent, CONTEST, config, state, client, { lexicon: WORD_LEXICON, rhymeIndex: EMPTY_RHYME_INDEX }));
  assert.equal(tick.autoProposedWord?.word, "key");
  assert.equal(tick.autoProposedWord?.gameId, "satoshitrump");

  const room = await client.readRoom("d-sonnet-1-team-satoshitrump", { since: 0 });
  assert.ok(room.messages.some((m) => m.from === agent.did && JSON.parse(m.text).word === "key"));
});

test("pollOnce: SONNET_AUTO_WRITE=true never throws out of the tick when it's NOT our turn -- just skips quietly", async () => {
  const agent = makeAgent();
  const other = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoWrite: true, dryRun: false, openAiApiKey: "sk-test", openAiModel: "gpt-test" };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const referee = makeTestIdentity();
  server.postSigned("d-sonnet-1-team-satoshitrump", referee, "room claimed, generation 0");
  // WE were the previous accepted contributor -- not our turn.
  server.postSigned("d-sonnet-1-team-satoshitrump", agent.identity, JSON.stringify({ type: "sonnet.word.v1", contest_id: "sonnet-1", game_id: "satoshitrump", room_generation: 0, version: 0, previous_state_hash: "", word: "eyed", request_id: "r-1" }));
  server.postSigned("d-sonnet-1-team-satoshitrump", referee, JSON.stringify({ request_id: "r-1", state_hash: "h1", version: 1 }));

  const state = {
    ...defaultState("sonnet-1", agent.did),
    roster: { members: [agent.did, other.did], requestId: "roster-1", signedAtUtc: "2026-09-11T13:00:00Z", gameId: "satoshitrump" },
  };
  const { tick, state: next } = await pollOnce(agent, CONTEST, config, state, client, { lexicon: WORD_LEXICON, rhymeIndex: EMPTY_RHYME_INDEX });
  assert.equal(tick.autoProposedWord, undefined);
  assert.ok(next); // the tick completed normally, no throw
});

test("pollOnce: SONNET_AUTO_WRITE has no effect without a locked roster (wordResources alone isn't enough)", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoWrite: true, dryRun: false, openAiApiKey: "sk-test", openAiModel: "gpt-test" };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const state = defaultState("sonnet-1", agent.did); // no roster at all
  const { tick } = await pollOnce(agent, CONTEST, config, state, client, { lexicon: WORD_LEXICON, rhymeIndex: EMPTY_RHYME_INDEX });
  assert.equal(tick.autoProposedWord, undefined);
});

test("pollOnce: tracks multiple own team-requests (additionalTeamRequests) and auto-signs whichever gets a valid roster first", async () => {
  const agent = makeAgent();
  const config: SonnetConfig = { ...loadSonnetConfig({}), autoTeam: true, dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const referee = makeTestIdentity();
  // Only the SECOND of our three hedge game_ids gets set up by the referee.
  server.postSigned("d-sonnet-1-team-hedge-b", referee, "room claimed, generation 0");
  const members = [agent.did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];
  server.postSigned(
    "mb-sonnet-1-discovery",
    makeTestIdentity(),
    JSON.stringify({ type: "sonnet.roster.v1", contest_id: "sonnet-1", game_id: "hedge-b", poem_room: "d-sonnet-1-team-hedge-b", room_generation: 0, members, request_id: "roster-b" }),
  );

  const state = {
    ...defaultState("sonnet-1", agent.did),
    team: { gameId: "hedge-a", requestId: "team-a", requestedAtUtc: "2026-09-11T13:00:00Z" },
    additionalTeamRequests: [
      { gameId: "hedge-b", requestId: "team-b", requestedAtUtc: "2026-09-11T13:00:00Z" },
      { gameId: "hedge-c", requestId: "team-c", requestedAtUtc: "2026-09-11T13:00:00Z" },
    ],
  };

  const { state: next, tick } = await pollOnce(agent, CONTEST, config, state, client);
  assert.deepEqual(tick.newlySetUpRooms, ["hedge-b"]);
  assert.equal(tick.autoSignedRoster?.gameId, "hedge-b");
  assert.equal(next.roster?.gameId, "hedge-b");
  assert.deepEqual(next.roster?.members, members);

  // hedge-a and hedge-c are untouched (never set up), still tracked.
  assert.equal(next.team?.gameId, "hedge-a");
  assert.deepEqual(
    next.additionalTeamRequests?.map((t) => t.gameId),
    ["hedge-b", "hedge-c"],
  );
});

test("pollOnce: reconciles ALL of our own team-requests observed in the room, not just the first, into team + additionalTeamRequests", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned("mb-sonnet-1-discovery", agent.identity, JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "hedge-1", request_id: "team-1" }));
  server.postSigned("mb-sonnet-1-discovery", agent.identity, JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "hedge-2", request_id: "team-2" }));
  server.postSigned("mb-sonnet-1-discovery", agent.identity, JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "hedge-3", request_id: "team-3" }));

  const state = { ...defaultState("sonnet-1", agent.did), phase: "DISCOVERING" as const };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.team?.gameId, "hedge-1"); // oldest becomes primary
  assert.deepEqual(next.additionalTeamRequests?.map((t) => t.gameId), ["hedge-2", "hedge-3"]);
  assert.equal(next.phase, "TEAM_REQUESTED");
});

test("pollOnce: a second machine's already-known team-requests aren't duplicated when reconciling new ones", async () => {
  const agent = makeAgent();
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  server.postSigned("mb-sonnet-1-discovery", agent.identity, JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "hedge-1", request_id: "team-1" }));
  server.postSigned("mb-sonnet-1-discovery", agent.identity, JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "hedge-2", request_id: "team-2" }));

  const state = {
    ...defaultState("sonnet-1", agent.did),
    phase: "TEAM_REQUESTED" as const,
    team: { gameId: "hedge-1", requestId: "team-1", requestedAtUtc: "2026-09-11T13:00:00Z" }, // already known locally
  };
  const { state: next } = await pollOnce(agent, CONTEST, config, state, client);

  assert.equal(next.team?.gameId, "hedge-1");
  assert.deepEqual(next.additionalTeamRequests?.map((t) => t.gameId), ["hedge-2"]); // only the new one added
});
