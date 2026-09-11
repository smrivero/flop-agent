import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { buildTeamRequestPreview, requestTeam, checkRoomSetup } from "./team.js";
import { loadSonnetConfig, type ContestConfig, type SonnetConfig } from "./config.js";

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

function throwingClient(): TechnocoreClient {
  return new TechnocoreClient({
    fetchImpl: async () => {
      throw new Error("network must never be called in this test");
    },
  });
}

test("buildTeamRequestPreview: canonical payload targets the discovery room and verifies locally", () => {
  const identity = makeTestIdentity();
  const config = loadSonnetConfig({});
  const preview = buildTeamRequestPreview(identity, CONTEST, config, "a", "req-1");
  assert.equal(preview.room, "mb-sonnet-1-discovery");
  assert.equal(preview.payload.game_id, "a");
  assert.equal(preview.verifiedLocally, true);
});

test("requestTeam: dry-run never touches the network", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: true };
  const result = await requestTeam(identity, CONTEST, config, "a", {}, throwingClient());
  assert.equal(result.sent, false);
});

test("requestTeam: alreadyRequested is a no-op, no network call", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const result = await requestTeam(identity, CONTEST, config, "a", { alreadyRequested: true }, throwingClient());
  assert.equal(result.sent, false);
});

test("requestTeam: real path sends and returns a seq", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const result = await requestTeam(identity, CONTEST, config, "a", {}, client);
  assert.equal(result.sent, true);
  assert.ok(typeof result.postedSeq === "number");
});

test("checkRoomSetup: reports hasMessages=false for an unset-up room, true once the referee (or anyone) has posted", async () => {
  const config = loadSonnetConfig({});
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const before = await checkRoomSetup(CONTEST, config, "a", client);
  assert.equal(before.hasMessages, false);

  const referee = makeTestIdentity();
  server.postSigned("d-sonnet-1-team-a", referee, "room claimed, generation 0");

  const after = await checkRoomSetup(CONTEST, config, "a", client);
  assert.equal(after.hasMessages, true);
  assert.equal(after.refereeCandidateDid, referee.did);
});
