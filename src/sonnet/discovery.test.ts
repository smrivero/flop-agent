import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { scan } from "./discovery.js";
import { loadSonnetConfig, type ContestConfig } from "./config.js";

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

function setup() {
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const config = loadSonnetConfig({});
  return { server, client, config };
}

test("scan: parses a writer registration and recognizes our own", async () => {
  const { server, client, config } = setup();
  const us = makeTestIdentity();
  await server.postSigned(
    "mb-sonnet-1-registration",
    us,
    JSON.stringify({ type: "sonnet.register.v1", contest_id: "sonnet-1", role: "writer", x_account_url: "https://x.com/us", request_id: "r-1" }),
  );

  const result = await scan(us.did, CONTEST, config, client);
  assert.equal(result.registrations.length, 1);
  assert.equal(result.registrations[0].role, "writer");
  assert.equal(result.registrations[0].xAccountUrl, "https://x.com/us");
  assert.ok(result.ourRegistration);
  assert.equal(result.ourRegistration!.did, us.did);
});

test("scan: duplicate registrations from the same DID -- only the first-seen is kept", async () => {
  const { server, client, config } = setup();
  const writer = makeTestIdentity();
  await server.postSigned("mb-sonnet-1-registration", writer, JSON.stringify({ type: "sonnet.register.v1", contest_id: "sonnet-1", role: "writer", x_account_url: "https://x.com/first", request_id: "r-1" }));
  await server.postSigned("mb-sonnet-1-registration", writer, JSON.stringify({ type: "sonnet.register.v1", contest_id: "sonnet-1", role: "writer", x_account_url: "https://x.com/second", request_id: "r-2" }));

  const observer = makeTestIdentity();
  const result = await scan(observer.did, CONTEST, config, client);
  assert.equal(result.registrations.length, 1);
  assert.equal(result.registrations[0].xAccountUrl, "https://x.com/first");
});

test("scan: parses a team-request and a roster proposal from the discovery room", async () => {
  const { server, client, config } = setup();
  const organizer = makeTestIdentity();
  await server.postSigned("mb-sonnet-1-discovery", organizer, JSON.stringify({ type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "a", request_id: "team-1" }));
  await server.postSigned(
    "mb-sonnet-1-discovery",
    organizer,
    JSON.stringify({
      type: "sonnet.roster.v1",
      contest_id: "sonnet-1",
      game_id: "a",
      poem_room: "d-sonnet-1-team-a",
      room_generation: 0,
      members: [organizer.did],
      request_id: "roster-1",
    }),
  );

  const observer = makeTestIdentity();
  const result = await scan(observer.did, CONTEST, config, client);
  assert.equal(result.teamRequests.length, 1);
  assert.equal(result.teamRequests[0].gameId, "a");
  assert.equal(result.rosterProposals.length, 1);
  assert.deepEqual(result.rosterProposals[0].members, [organizer.did]);
});

test("scan: ignores malformed/unrelated messages in the registration room without crashing", async () => {
  const { server, client, config } = setup();
  const someone = makeTestIdentity();
  server.inject("mb-sonnet-1-registration", { from: someone.did, text: "not json at all", nonce: 1 });
  server.inject("mb-sonnet-1-registration", { from: someone.did, text: '{"type":"sonnet.register.v1","contest_id":"sonnet-1","role":"not-a-role","request_id":"r-1"}', nonce: 2 });
  server.inject("mb-sonnet-1-registration", { from: someone.did, text: '{"type":"other.thing","contest_id":"sonnet-1","request_id":"r-1"}', nonce: 3 });

  const observer = makeTestIdentity();
  const result = await scan(observer.did, CONTEST, config, client);
  assert.equal(result.registrations.length, 0);
  assert.equal(result.roomErrors.length, 0);
});

test("scan: parses an existing submission from the submissions room", async () => {
  const { server, client, config } = setup();
  const finisher = makeTestIdentity();
  await server.postSigned(
    "mb-sonnet-1-submissions",
    finisher,
    JSON.stringify({ type: "sonnet.submit.v1", contest_id: "sonnet-1", game_id: "a", poem_room: "d-sonnet-1-team-a", room_generation: 0, final_version: 98, poem_sha256: "x".repeat(64), x_post_ids: ["1"], request_id: "sub-1" }),
  );

  const observer = makeTestIdentity();
  const result = await scan(observer.did, CONTEST, config, client);
  assert.equal(result.submissions.length, 1);
  assert.equal(result.submissions[0].gameId, "a");
});

test("scan: collects a single sonnet.receipt.v1 addressed to our own DID, ignores ones addressed to others", async () => {
  const { server, client, config } = setup();
  const referee = makeTestIdentity();
  const us = makeTestIdentity();
  const someoneElse = makeTestIdentity();
  await server.postSigned(
    "mb-sonnet-1-registration",
    referee,
    JSON.stringify({ type: "sonnet.receipt.v1", contest_id: "sonnet-1", request_id: "reg-us", sender_did: us.did, status: "accepted", reason: "" }),
  );
  await server.postSigned(
    "mb-sonnet-1-registration",
    referee,
    JSON.stringify({ type: "sonnet.receipt.v1", contest_id: "sonnet-1", request_id: "reg-other", sender_did: someoneElse.did, status: "accepted", reason: "" }),
  );

  const result = await scan(us.did, CONTEST, config, client);
  assert.equal(result.ownReceipts.length, 1);
  assert.equal(result.ownReceipts[0].requestId, "reg-us");
  assert.equal(result.ownReceipts[0].status, "accepted");
});

test("scan: collects our own entry out of a batched sonnet.receipts.v1 (no top-level request_id)", async () => {
  const { server, client, config } = setup();
  const referee = makeTestIdentity();
  const us = makeTestIdentity();
  const someoneElse = makeTestIdentity();
  await server.postSigned(
    "mb-sonnet-1-discovery",
    referee,
    JSON.stringify({
      type: "sonnet.receipts.v1",
      contest_id: "sonnet-1",
      status: "rejected",
      reason: "room request: writer or organizer",
      receipts: [
        { request_id: "team-other", sender_did: someoneElse.did },
        { request_id: "team-us", sender_did: us.did },
      ],
    }),
  );

  const result = await scan(us.did, CONTEST, config, client);
  assert.equal(result.ownReceipts.length, 1);
  assert.equal(result.ownReceipts[0].requestId, "team-us");
  assert.equal(result.ownReceipts[0].status, "rejected");
  assert.equal(result.ownReceipts[0].reason, "room request: writer or organizer");
});
