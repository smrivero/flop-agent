/**
 * Crash safety of the write journal against an in-memory technocore that enforces the real
 * server's rules (signatures, per-key nonces, duplicate filter, owned rooms, ownership notes).
 * Keys here are throwaway test keys generated in memory; no real key exists or is written.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, before, test } from "node:test";
import { didFromPublicKey } from "../identity.js";
import { OfficialFold } from "./fold.js";
import { AmbiguousOperation, WriteJournal, type WriteOp } from "./journal.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { ownerMessageText, tradeMessageText, canonicalTerms, makerSigningString, takerSigningString, type Terms } from "./protocol.js";
import { buildSignedNote, type Signer } from "./protocol-writes.js";
import { planOwnershipRefresh, allowListValue } from "./room.js";
import { foldConfig } from "./paper.js";
import { contest, tmpDb, VENDOR } from "./test-helpers.js";
import { MockTechnocore } from "./testing/mock-technocore.js";
import { join } from "node:path";

function testSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const did = didFromPublicKey(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { did, sign: (m: string) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64url") };
}

const A = testSigner();
const B = testSigner();
const signers = new Map([["CC001", A], ["CC002", B]]);
const ROOM = "d-cc-test";
const ownerOp = (id: string, s: Signer): WriteOp => ({ opKey: `owner:${id}`, kind: "owner", signerId: id, room: "close1", text: ownerMessageText(s.did) });

let fold: OfficialFold;
before(async () => { fold = await OfficialFold.start("python3", VENDOR, foldConfig(contest())); });
after(() => fold.stop());

test("1. crash BEFORE signing: the planned op is prepared and sent once on recovery", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  new WriteJournal(db, signers, srv).plan(ownerOp("CC001", A));          // process dies here
  const rows = await new WriteJournal(db, signers, srv).recover();
  assert.equal(rows[0].state, "CONFIRMED");
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 1);
});

test("2. crash AFTER signing, BEFORE publishing: the same signed body (same nonce) is sent once", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const j = new WriteJournal(db, signers, srv);
  const prepared = j.prepare(j.plan(ownerOp("CC001", A)));                // dies after persisting the signature
  const rows = await new WriteJournal(db, signers, srv).recover();
  assert.equal(rows[0].state, "CONFIRMED");
  assert.equal(rows[0].nonce, prepared.nonce, "no re-signing needed");
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 1);
});

test("3. crash DURING the HTTP request (never reached the server): read-back finds nothing, resend once", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  srv.failNext("drop");
  const first = await new WriteJournal(db, signers, srv).execute(ownerOp("CC001", A));
  assert.equal(first.state, "UNKNOWN");
  const rows = await new WriteJournal(db, signers, srv).recover();
  assert.equal(rows[0].state, "CONFIRMED");
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 1);
});

test("4. server stored it but the client timed out: read-back confirms, NO second copy", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  srv.failNext("timeout-after-commit");
  const j = new WriteJournal(db, signers, srv);
  assert.equal((await j.execute(ownerOp("CC001", A))).state, "UNKNOWN");
  const postsBefore = srv.posts;
  const [row] = await j.recover();
  assert.equal(row.state, "CONFIRMED");
  assert.equal(srv.posts, postsBefore, "resolved by reading, not by resending");
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 1);
});

test("5. write confirmed but the process died before persisting the response: recovered as CONFIRMED", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const j = new WriteJournal(db, signers, srv);
  const row = j.prepare(j.plan(ownerOp("CC001", A)));
  const req = JSON.parse(row.body).request;
  db.prepare("UPDATE write_attempts SET state = 'SENDING' WHERE attempt_id = ?").run(row.attempt_id);
  await srv.post(req.path, req.body);                                     // the server got it; we died before recording
  const [r] = await new WriteJournal(db, signers, srv).recover();
  assert.equal(r.state, "CONFIRMED");
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 1);
});

function signedTrade(id: string, until: number): string {
  const terms: Terms = { id, maker: A.did, px: "226.00", qty: "0.10", side: "buy", taker: B.did, until };
  return tradeMessageText(terms, B.did, A.sign(makerSigningString(terms)), B.sign(takerSigningString(terms, B.did)));
}

test("6. restart with a trade in flight: even a duplicated trade message settles once in the official fold", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const text = signedTrade("a".repeat(32), 10);
  srv.failNext("timeout-after-commit");
  const j = new WriteJournal(db, signers, srv);
  await j.execute({ opKey: "trade:" + "a".repeat(32), kind: "trade", signerId: "CC001", room: "close1", text });
  await new WriteJournal(db, signers, srv).recover();
  assert.equal(srv.count("close1", text), 1, "the journal did not duplicate it");
  // Worst case anyway (someone reposts it): the referee settles an id once.
  await fold.reset(foldConfig(contest()));
  await fold.seed("226.00");
  const wire = { id: "a".repeat(32), maker: A.did, side: "buy", qty: "0.10", px: "226.00", taker: B.did, until: 10, countersigner: B.did };
  const r = await fold.sweep(2, "226.00", "226.00", [A.did, B.did], [wire, wire, wire] as never);
  assert.deepEqual(r.trades.map((t) => t.outcome + (t.reason ? ":" + t.reason : "")), ["settled", "void:settled", "void:settled"]);
  const acc = await fold.accounts([A.did], "226.00");
  assert.equal(acc.accounts[A.did].position, "0.10", "one position, never two");
});

test("7. restart with a registration in flight: one message; a duplicate owner message would still mint once", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  srv.failNext("timeout-after-commit");
  await new WriteJournal(db, signers, srv).execute(ownerOp("CC002", B));
  await new WriteJournal(db, signers, srv).recover();
  assert.equal(srv.count("close1", ownerMessageText(B.did)), 1);
  await fold.reset(foldConfig(contest()));
  await fold.seed("226.00");
  const r = await fold.sweep(1, "226.00", "226.00", [B.did, B.did], []);
  assert.deepEqual(r.minted, [B.did]);
});

test("8. local nonce BEHIND the server (e.g. restored backup): re-signed above it, sent once, text intact", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const future = BigInt(Date.now()) + 10_000_000n;
  srv.lastNonce.set(`close1|${A.did}`, future);                          // server saw a higher nonce from this key
  srv.rooms.set("close1", [{ seq: 1, from: A.did, text: "earlier message", nonce: future.toString() }]);
  const row = await new WriteJournal(db, signers, srv).execute(ownerOp("CC001", A));
  assert.equal(row.state, "CONFIRMED");
  assert.ok(BigInt(row.nonce) > future);
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 1);
});

test("9. local nonce AHEAD of the server: accepted as is", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const j = new WriteJournal(db, signers, srv);
  const ahead = (BigInt(Date.now()) + 5_000_000n).toString();
  db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', 'room:close1', ?, 'x')").run(ahead);
  const row = await j.execute(ownerOp("CC001", A));
  assert.equal(row.state, "CONFIRMED");
  assert.equal(BigInt(row.nonce), BigInt(ahead) + 1n);
});

test("10. two instances cannot run: the second one is refused; a dead holder's lock is replaced", async () => {
  const { dir } = tmpDb();
  const path = join(dir, "closecall.lock");
  const first = await acquireLock(path, "node close-call test");
  await assert.rejects(() => acquireLock(path, "node close-call test"), LockHeldError);
  first.release();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ pid: 999_999, host: (await import("node:os")).hostname(), bootId: null, startedAt: "x", cmd: "close-call" }));
  const again = await acquireLock(path, "node close-call test");
  again.release();
});

test("an operation that stays ambiguous halts instead of guessing", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  for (let i = 0; i < 10; i++) srv.failNext("drop");
  let halted = "";
  const j = new WriteJournal(db, signers, srv, { maxResolveTries: 3, onAmbiguous: (_r, why) => { halted = why; } });
  await j.execute(ownerOp("CC001", A));
  await assert.rejects(() => j.recover(), AmbiguousOperation);
  assert.match(halted, /still ambiguous/);
  assert.equal(srv.count("close1", ownerMessageText(A.did)), 0);
});

test("owned d- room: claim, one-write 99-DID allow-list over POST, members can write, strangers cannot", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const members = Array.from({ length: 99 }, testSigner);
  const allSigners = new Map<string, Signer>([["CC001", A], ...members.map((s, i) => [`M${i}`, s] as [string, Signer])]);
  const j = new WriteJournal(db, allSigners, srv);
  assert.equal((await j.execute({ opKey: `note:owners:${ROOM}`, kind: "note-owners", signerId: "CC001", room: ROOM, value: A.did, ifAbsent: true })).state, "CONFIRMED");
  const value = allowListValue(members.map((m) => m.did));
  assert.ok(value.length > 5500 && value.length < 8192, `${value.length} chars in one note`);
  const allowRow = await j.execute({ opKey: `note:allow:${ROOM}`, kind: "note-allow", signerId: "CC001", room: ROOM, value });
  assert.equal(allowRow.state, "CONFIRMED");
  assert.equal(JSON.parse(allowRow.body).request.path, `/kv/room-allow/${ROOM}`, "POST body lane, not a giant GET URL");
  assert.equal(await srv.readNote("room-allow", ROOM), value, "round-trips byte for byte");
  assert.equal((await j.execute({ opKey: "m0", kind: "owner", signerId: "M0", room: ROOM, text: ownerMessageText(members[0].did) })).state, "CONFIRMED");
  const stranger = testSigner();
  const bad = buildSignedNote(stranger, "room-allow", ROOM, String(Date.now() * 10), stranger.did);
  assert.equal((await srv.post(bad.path, bad.body)).status, 403, "only the owner writes the allow-list");
  const j2 = new WriteJournal(db, new Map([["X", stranger]]), srv);
  assert.equal((await j2.execute({ opKey: "x", kind: "owner", signerId: "X", room: ROOM, text: ownerMessageText(stranger.did) })).state, "FAILED");
});

test("ownership refresh: verifies first, re-signs the same values, refuses a different owner or allow-list", async () => {
  const { db } = tmpDb();
  const srv = new MockTechnocore();
  const members = [B.did];
  const j = new WriteJournal(db, signers, srv);
  await j.execute({ opKey: "claim", kind: "note-owners", signerId: "CC001", room: ROOM, value: A.did, ifAbsent: true });
  await j.execute({ opKey: "allow", kind: "note-allow", signerId: "CC001", room: ROOM, value: allowListValue(members) });
  const base = { room: ROOM, ownerId: "CC001", ownerDid: A.did, allowDids: members, days: 5 };
  assert.equal((await planOwnershipRefresh(srv, { ...base, lastRefreshMs: Date.now() - 86_400_000, nowMs: Date.now() })).action, "not-due");
  const plan = await planOwnershipRefresh(srv, { ...base, lastRefreshMs: Date.now() - 6 * 86_400_000, nowMs: Date.now() });
  assert.equal(plan.action, "refresh");
  const counterBefore = BigInt((await srv.readNote("room-nonce", ROOM))!);
  for (const w of plan.writes) assert.equal((await j.execute(w)).state, "CONFIRMED");
  assert.equal(await srv.readNote("room-owners", ROOM), A.did);
  assert.equal(await srv.readNote("room-allow", ROOM), allowListValue(members));
  assert.ok(BigInt((await srv.readNote("room-nonce", ROOM))!) > counterBefore, "notes were rewritten (fresh mtime on the real server)");
  srv.notes.set(`room-allow/${ROOM}`, allowListValue([B.did, testSigner().did]));
  const bad = await planOwnershipRefresh(srv, { ...base, lastRefreshMs: null, nowMs: Date.now() });
  assert.equal(bad.action, "halt");
  assert.equal(bad.writes.length, 0, "never overwrites a list that is not exactly ours");
  srv.notes.set(`room-owners/${ROOM}`, B.did);
  assert.match((await planOwnershipRefresh(srv, { ...base, lastRefreshMs: null, nowMs: Date.now() })).reason, /not our owner/);
});

void canonicalTerms;
