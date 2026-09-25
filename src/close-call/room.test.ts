import assert from "node:assert/strict";
import { test } from "node:test";
import { paperDid } from "./keys.js";
import { allowListMatches, allowListValue, findRoomRegistration, getRoom, IllegalRoomTransition, ROOM_STATUSES, sha256, transitionRoom } from "./room.js";
import { tmpDb } from "./test-helpers.js";

const OWNER = paperDid("OWNER");
const DIDS = Array.from({ length: 99 }, (_, i) => paperDid(`ALLOW${i}`));

test("room state machine: UNCREATED -> CLAIMED -> ALLOWLIST_PENDING -> REGISTER_PENDING -> REGISTER_CONFIRMED -> READY, each with evidence", () => {
  const { db } = tmpDb();
  const r = "d-cc-test";
  assert.deepEqual(ROOM_STATUSES, ["UNCREATED", "CLAIMED", "ALLOWLIST_PENDING", "REGISTER_PENDING", "REGISTER_CONFIRMED", "READY", "ERROR"]);
  assert.equal(getRoom(db, r).status, "UNCREATED");
  assert.throws(() => transitionRoom(db, r, "REGISTER_PENDING", { kind: "flow.rooms", sweep: 1 }), IllegalRoomTransition, "no skipping");
  assert.throws(() => transitionRoom(db, r, "CLAIMED", { kind: "owner-note", owner: paperDid("SOMEONE") }, OWNER), /not our key/);
  transitionRoom(db, r, "CLAIMED", { kind: "owner-note", owner: OWNER }, OWNER);
  transitionRoom(db, r, "ALLOWLIST_PENDING", { kind: "allow-sent", dids: 99 });
  assert.throws(() => transitionRoom(db, r, "REGISTER_PENDING", { kind: "allow-sent", dids: 99 }), /needs evidence allow-note\+room-message/);
  transitionRoom(db, r, "REGISTER_PENDING", { kind: "allow-note+room-message", value_sha256: sha256(allowListValue(DIDS)), dids: 99, room_message_seq: 12345 });
  assert.throws(() => transitionRoom(db, r, "REGISTER_CONFIRMED", { kind: "owner-note", owner: OWNER }), /needs evidence flow.rooms/, "a posted room message is not a registration");
  transitionRoom(db, r, "REGISTER_CONFIRMED", { kind: "flow.rooms", sweep: 60 });
  const ready = transitionRoom(db, r, "READY", { kind: "owner-mint-confirmed", owner: OWNER, sweep: 59 });
  assert.equal(ready.status, "READY");
  assert.equal(JSON.parse(ready.evidence!).length, 5, "full evidence history kept");
});

test("allow-list: one note holding every DID, verified by read-back; registration found only in referee flow posts", () => {
  const value = allowListValue(DIDS);
  assert.equal(value.split(" ").length, 99);
  assert.ok(value.length < 8192, `${value.length} chars fits one note`);
  assert.ok(allowListMatches(value, DIDS));
  assert.ok(!allowListMatches(allowListValue(DIDS.slice(1)), DIDS), "a missing DID fails verification");
  const { db } = tmpDb();
  assert.equal(findRoomRegistration(db, "d-cc-test"), null);
  db.prepare(`INSERT INTO raw_posts (room, seq, generation, ts, from_did, text, fetched_at) VALUES ('d-close1-flow', 1, 1, 't', 'r', ?, 'x')`)
    .run(JSON.stringify({ t: "flow", n: 61, rooms: ["nvda-desk", "d-cc-test"] }));
  assert.equal(findRoomRegistration(db, "d-cc-test"), 61);
});
