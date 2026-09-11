import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import { buildRecruitMessageText, buildOwnTeamRecruitText, buildRecruitPreview, recruit, recruitForOwnTeam } from "./recruit.js";
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

test("buildRecruitMessageText: mentions the contest id and stays a single line", () => {
  const text = buildRecruitMessageText(CONTEST);
  assert.ok(text.includes("sonnet-1"));
  assert.equal(text.includes("\n"), false);
});

test("buildRecruitPreview: targets the discovery room and verifies locally", () => {
  const identity = makeTestIdentity();
  const config = loadSonnetConfig({});
  const preview = buildRecruitPreview(identity, CONTEST, config);
  assert.equal(preview.room, "mb-sonnet-1-discovery");
  assert.equal(preview.verifiedLocally, true);
});

test("recruit: dry-run never touches the network", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: true };
  const result = await recruit(identity, CONTEST, config, { minIntervalMs: 1000 }, throwingClient());
  assert.equal(result.sent, false);
  assert.equal(result.rateLimited, false);
});

test("recruit: rate-limited when the last message was too recent -- never touches the network", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const result = await recruit(
    identity,
    CONTEST,
    config,
    { lastSentAtUtc: new Date().toISOString(), minIntervalMs: 3_600_000 },
    throwingClient(),
  );
  assert.equal(result.sent, false);
  assert.equal(result.rateLimited, true);
});

test("recruit: sends when enough time has elapsed since the last message", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const longAgo = new Date(Date.now() - 7_200_000).toISOString();
  const result = await recruit(identity, CONTEST, config, { lastSentAtUtc: longAgo, minIntervalMs: 3_600_000 }, client);
  assert.equal(result.sent, true);
  assert.equal(result.rateLimited, false);
});

test("buildOwnTeamRecruitText: names our own game_id and invites people to join it, not 'looking for a team'", () => {
  const text = buildOwnTeamRecruitText("satoshitrump", CONTEST);
  assert.ok(text.includes("satoshitrump"));
  assert.ok(text.includes("Started team-request"));
  assert.equal(text.toLowerCase().includes("looking for a team of"), false);
});

test("recruitForOwnTeam: sends the own-team message, not the generic broadcast one", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const result = await recruitForOwnTeam(identity, CONTEST, config, "satoshitrump", { minIntervalMs: 1000 }, client);
  assert.equal(result.sent, true);
  assert.ok(result.preview.text.includes("satoshitrump"));
});
