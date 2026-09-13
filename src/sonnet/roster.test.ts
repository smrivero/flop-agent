import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocore, makeTestIdentity } from "../tclk/testUtils.js";
import {
  buildRosterPreview,
  detectRosterConflict,
  summarizeRosterSigners,
  signRoster,
  RosterError,
} from "./roster.js";
import type { ObservedRoster } from "./discovery.js";
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

function observed(gameId: string, did: string, members: string[], seq: number): ObservedRoster {
  return { did, gameId, poemRoom: `d-sonnet-1-team-${gameId}`, roomGeneration: 0, members, requestId: `r-${seq}`, seq, ts: "2026-09-11T13:00:00Z" };
}

function throwingClient(): TechnocoreClient {
  return new TechnocoreClient({
    fetchImpl: async () => {
      throw new Error("network must never be called in this test");
    },
  });
}

/** Four fresh, valid did:key DIDs -- reused across the buildRosterPreview/
 * signRoster tests below, which need `buildRosterPayload`'s own DID-shape
 * validation to pass. */
function fourMemberDids(): string[] {
  return [makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did, makeTestIdentity().did];
}

test("detectRosterConflict: no conflict when nothing else has been observed for this game_id", () => {
  const conflict = detectRosterConflict("a", ["did:key:1", "did:key:2", "did:key:3", "did:key:4"], []);
  assert.equal(conflict, undefined);
});

test("detectRosterConflict: no conflict when the only other proposal is the SAME exact members list (a co-signer)", () => {
  const members = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const conflict = detectRosterConflict("a", members, [observed("a", "did:key:2", members, 1)]);
  assert.equal(conflict, undefined);
});

test("detectRosterConflict: flags a DIFFERENT members list for the same game_id -- valid vs conflicting roster", () => {
  const intended = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const different = ["did:key:1", "did:key:2", "did:key:3", "did:key:5"];
  const conflict = detectRosterConflict("a", intended, [observed("a", "did:key:9", different, 1)]);
  assert.ok(conflict);
  assert.equal(conflict!.conflictingProposals.length, 1);
});

test("detectRosterConflict: order matters -- same members in a different order is still a conflict ('the same roster')", () => {
  const intended = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const reordered = ["did:key:2", "did:key:1", "did:key:3", "did:key:4"];
  const conflict = detectRosterConflict("a", intended, [observed("a", "did:key:9", reordered, 1)]);
  assert.ok(conflict);
});

test("detectRosterConflict: a same-game_id proposal with ZERO overlapping members is NOT a conflict -- an unrelated group squatting the same name", () => {
  const intended = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const unrelated = ["did:key:9", "did:key:10", "did:key:11", "did:key:12"];
  const conflict = detectRosterConflict("a", intended, [observed("a", "did:key:9", unrelated, 1)]);
  assert.equal(conflict, undefined);
});

test("detectRosterConflict: a same-game_id proposal sharing even ONE member is still a conflict", () => {
  const intended = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const partiallyShared = ["did:key:1", "did:key:9", "did:key:10", "did:key:11"]; // only did:key:1 overlaps
  const conflict = detectRosterConflict("a", intended, [observed("a", "did:key:9", partiallyShared, 1)]);
  assert.ok(conflict);
  assert.equal(conflict!.conflictingProposals.length, 1);
});

test("detectRosterConflict: a proposal for a DIFFERENT game_id never conflicts", () => {
  const intended = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const conflict = detectRosterConflict("a", intended, [observed("b", "did:key:9", ["did:key:9"], 1)]);
  assert.equal(conflict, undefined);
});

test("summarizeRosterSigners: reports confirmed vs pending members", () => {
  const members = ["did:key:1", "did:key:2", "did:key:3", "did:key:4"];
  const observedProposals = [observed("a", "did:key:2", members, 1), observed("a", "did:key:4", members, 2)];
  const status = summarizeRosterSigners("a", members, observedProposals);
  assert.deepEqual(status.confirmedSigners, ["did:key:2", "did:key:4"]);
  assert.deepEqual(status.pendingSigners, ["did:key:1", "did:key:3"]);
});

test("buildRosterPreview: canonical payload targets the discovery room and verifies locally", () => {
  const identity = makeTestIdentity();
  const config = loadSonnetConfig({});
  const members = [identity.did, ...fourMemberDids().slice(1)];
  const preview = buildRosterPreview(identity, CONTEST, config, { gameId: "a", poemRoom: "d-sonnet-1-team-a", roomGeneration: 0, members, requestId: "roster-1" });
  assert.equal(preview.room, "mb-sonnet-1-discovery");
  assert.equal(preview.verifiedLocally, true);
  assert.deepEqual(preview.payload.members, members);
});

test("signRoster: refuses to sign (and never touches the network) when a conflict is observed", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const intended = [identity.did, ...fourMemberDids().slice(1)];
  const different = [...intended.slice(0, 3), makeTestIdentity().did];
  const conflicting = [observed("a", intended[1], different, 1)];

  await assert.rejects(
    () => signRoster(identity, CONTEST, config, { gameId: "a", poemRoom: "d-sonnet-1-team-a", roomGeneration: 0, members: intended }, conflicting, throwingClient()),
    RosterError,
  );
});

test("signRoster: dry-run never touches the network", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: true };
  const members = [identity.did, ...fourMemberDids().slice(1)];
  const result = await signRoster(identity, CONTEST, config, { gameId: "a", poemRoom: "d-sonnet-1-team-a", roomGeneration: 0, members }, [], throwingClient());
  assert.equal(result.sent, false);
});

test("signRoster: real path (no conflict) sends", async () => {
  const identity = makeTestIdentity();
  const config: SonnetConfig = { ...loadSonnetConfig({}), dryRun: false };
  const members = [identity.did, ...fourMemberDids().slice(1)];
  const server = new FakeTechnocore();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });

  const result = await signRoster(identity, CONTEST, config, { gameId: "a", poemRoom: "d-sonnet-1-team-a", roomGeneration: 0, members }, [], client);
  assert.equal(result.sent, true);
  assert.ok(typeof result.postedSeq === "number");
});
