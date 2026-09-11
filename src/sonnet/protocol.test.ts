import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sonnetRooms,
  toCanonicalJson,
  tryParseSonnetMessage,
  buildRegisterPayload,
  buildTeamRequestPayload,
  buildRosterPayload,
  buildWithdrawPayload,
  buildWordPayload,
  buildSubmitPayload,
  freshRequestId,
  GAME_ID_PATTERN,
  RegistrationPayloadError,
  ProtocolPayloadError,
} from "./protocol.js";
import { generateIdentitySeed } from "../identity.js";
import type { ContestConfig } from "./config.js";

const DID_A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const DID_B = "did:key:z6MkereFQqHaUdcF7yVmHvY1rHpAvVjeCggaBVy45hmE8G6C";
function freshDid(): string {
  return generateIdentitySeed().did;
}

const CONTEST: ContestConfig = {
  contest_id: "sonnet-1",
  rules_version: "0.5",
  opening: "2026-09-11T12:00:00Z",
  deadline: "2026-09-18T12:00:00Z",
  prize: 50000,
  voter_pool: 50000,
  payment_unit: "FLOP",
  payment_method: "FLOP transfer to the destination in the accepted signed prize claim",
  theme: null,
  identity_policy: "verified-prestart-did",
  identity_cutoff: "2026-09-11T12:00:00Z",
};

test("sonnetRooms: matches the literal room table in sonnet-game.md exactly", () => {
  const rooms = sonnetRooms(CONTEST);
  assert.equal(rooms.rules, "d-sonnet-1-rules");
  assert.equal(rooms.registration, "mb-sonnet-1-registration");
  assert.equal(rooms.discovery, "mb-sonnet-1-discovery");
  assert.equal(rooms.campaign, "mb-sonnet-1-campaign");
  assert.equal(rooms.votes, "mb-sonnet-1-votes");
  assert.equal(rooms.submissions, "mb-sonnet-1-submissions");
  assert.equal(rooms.results, "d-sonnet-1-results");
  assert.equal(rooms.team("a"), "d-sonnet-1-team-a");
});

test("sonnetRooms: team() rejects a game_id outside the protocol's own pattern", () => {
  const rooms = sonnetRooms(CONTEST);
  assert.throws(() => rooms.team(""), RangeError);
  assert.throws(() => rooms.team("Has-Upper"), RangeError);
  assert.throws(() => rooms.team("-startswithdash"), RangeError);
  assert.throws(() => rooms.team("a".repeat(17)), RangeError);
  assert.doesNotThrow(() => rooms.team("a".repeat(16)));
  assert.match("a1_b-2", GAME_ID_PATTERN);
});

test("buildRegisterPayload: writer requires a canonical x_account_url", () => {
  assert.throws(
    () => buildRegisterPayload({ role: "writer", requestId: "r-1", contestId: "sonnet-1" }),
    RegistrationPayloadError,
  );
  assert.throws(
    () => buildRegisterPayload({ role: "writer", xAccountUrl: "https://twitter.com/x", requestId: "r-1", contestId: "sonnet-1" }),
    RegistrationPayloadError,
  );
  const payload = buildRegisterPayload({ role: "writer", xAccountUrl: "https://x.com/some_handle", requestId: "r-1", contestId: "sonnet-1" });
  assert.equal(payload.x_account_url, "https://x.com/some_handle");
});

test("buildRegisterPayload: voter/organizer must omit x_account_url", () => {
  assert.throws(
    () => buildRegisterPayload({ role: "voter", xAccountUrl: "https://x.com/x", requestId: "r-1", contestId: "sonnet-1" }),
    RegistrationPayloadError,
  );
  const payload = buildRegisterPayload({ role: "organizer", requestId: "r-1", contestId: "sonnet-1" });
  assert.equal("x_account_url" in payload, false);
});

test("toCanonicalJson: produces single-line, deterministic JSON for the same input", () => {
  const payload = buildRegisterPayload({ role: "organizer", requestId: "r-1", contestId: "sonnet-1" });
  const json = toCanonicalJson(payload);
  assert.equal(json.includes("\n"), false);
  assert.equal(json, toCanonicalJson(payload));
  assert.deepEqual(JSON.parse(json), payload);
});

test("tryParseSonnetMessage: accepts well-formed envelopes, ignores everything else", () => {
  const parsed = tryParseSonnetMessage('{"type":"sonnet.register.v1","contest_id":"sonnet-1","role":"writer","request_id":"r-1"}');
  assert.ok(parsed);
  assert.equal(parsed!.type, "sonnet.register.v1");

  for (const text of ["not json", "{}", '{"type":"other.v1","contest_id":"sonnet-1","request_id":"r-1"}', "42", "null"]) {
    assert.equal(tryParseSonnetMessage(text), undefined, `expected ${text} to be ignored`);
  }
});

test("freshRequestId: unique across calls and carries the given prefix", () => {
  const a = freshRequestId("register");
  const b = freshRequestId("register");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("register-"));
});

test("buildTeamRequestPayload: validates game_id and produces the exact wire shape", () => {
  const payload = buildTeamRequestPayload({ contestId: "sonnet-1", gameId: "a", requestId: "r-1" });
  assert.deepEqual(payload, { type: "sonnet.team-request.v1", contest_id: "sonnet-1", game_id: "a", request_id: "r-1" });
  assert.throws(() => buildTeamRequestPayload({ contestId: "sonnet-1", gameId: "Bad ID", requestId: "r-1" }), ProtocolPayloadError);
});

test("buildRosterPayload: enforces 4-8 distinct valid DIDs and produces the exact wire shape", () => {
  const members = [DID_A, DID_B, freshDid(), freshDid()];
  const payload = buildRosterPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "d-sonnet-1-team-a", roomGeneration: 0, members, requestId: "r-1" });
  assert.deepEqual(payload.members, members);
  assert.equal(payload.type, "sonnet.roster.v1");

  assert.throws(
    () => buildRosterPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, members: [DID_A, DID_B, freshDid()], requestId: "r-1" }),
    ProtocolPayloadError,
    "fewer than 4 members must be rejected",
  );
  assert.throws(
    () => buildRosterPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, members: Array.from({ length: 9 }, freshDid), requestId: "r-1" }),
    ProtocolPayloadError,
    "more than 8 members must be rejected",
  );
  assert.throws(
    () => buildRosterPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, members: [DID_A, DID_A, freshDid(), freshDid()], requestId: "r-1" }),
    ProtocolPayloadError,
    "duplicate DIDs must be rejected",
  );
  assert.throws(
    () => buildRosterPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, members: ["not-a-did", DID_A, freshDid(), freshDid()], requestId: "r-1" }),
    ProtocolPayloadError,
    "a malformed DID must be rejected",
  );
});

test("buildWithdrawPayload: exact wire shape", () => {
  assert.deepEqual(buildWithdrawPayload({ contestId: "sonnet-1", gameId: "a", requestId: "r-1" }), {
    type: "sonnet.withdraw.v1",
    contest_id: "sonnet-1",
    game_id: "a",
    request_id: "r-1",
  });
});

test("buildWordPayload: rejects a non-single-word token, accepts a valid one", () => {
  assert.throws(
    () => buildWordPayload({ contestId: "sonnet-1", gameId: "a", roomGeneration: 0, version: 0, previousStateHash: "x", word: "two words", requestId: "r-1" }),
    ProtocolPayloadError,
  );
  const payload = buildWordPayload({ contestId: "sonnet-1", gameId: "a", roomGeneration: 0, version: 3, previousStateHash: "abc", word: "The", requestId: "r-1" });
  assert.equal(payload.word, "The");
  assert.equal(payload.version, 3);
});

test("buildSubmitPayload: requires a 64-hex sha256 and at least one post id", () => {
  const sha = "a".repeat(64);
  assert.throws(
    () => buildSubmitPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, finalVersion: 98, poemSha256: "not-hex", xPostIds: ["1"], requestId: "r-1" }),
    ProtocolPayloadError,
  );
  assert.throws(
    () => buildSubmitPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, finalVersion: 98, poemSha256: sha, xPostIds: [], requestId: "r-1" }),
    ProtocolPayloadError,
  );
  const payload = buildSubmitPayload({ contestId: "sonnet-1", gameId: "a", poemRoom: "x", roomGeneration: 0, finalVersion: 98, poemSha256: sha, xPostIds: ["1", "2"], requestId: "r-1" });
  assert.equal(payload.poem_sha256, sha);
});
