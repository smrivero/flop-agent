/**
 * Live writer preparation, all offline: the backup gate, key generation (throwaway keys in a temp
 * dir, deleted with it), signed trades, and the full bootstrap against the in-memory server.
 * Nothing here talks to technocore.chat.
 */

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyEd25519 } from "../identity.js";
import { backupGate, ensureCanary, recordBackup, recordVerification, verifyCode } from "./backup-gate.js";
import { Bootstrap } from "./bootstrap.js";
import { sweepTime } from "./contest.js";
import { WriteJournal } from "./journal.js";
import { ensurePaperKeys, keyId, listKeys } from "./keys.js";
import { generateKeys, KeygenRefused, loadSigners, verifyRestoredKeyDir } from "./live/keygen.js";
import { makerSigningString, newTradeId, takerSigningString, type Terms } from "./protocol.js";
import { buildSignedTrade, type Signer } from "./protocol-writes.js";
import { getRoom } from "./room.js";
import { activeHalts } from "./safety.js";
import { getMeta, now } from "./store.js";
import { contest, tmpDb } from "./test-helpers.js";
import { simulateBootstrap } from "./testing/bootstrap-sim.js";
import { ephemeralSigner } from "./testing/ephemeral-signer.js";
import { MockTechnocore } from "./testing/mock-technocore.js";

const RECIPIENT = "age1" + "q".repeat(58);

function vault() {
  const { db, dir } = tmpDb();
  const keysDir = join(dir, "keys");
  const backupDir = join(dir, "backups");
  mkdirSync(keysDir, { mode: 0o700 });
  mkdirSync(backupDir, { mode: 0o700 });
  return { db, dir, keysDir, backupDir, g: { keysDir, backupDir, recipient: RECIPIENT } };
}

/** Stand-in for closecall-backup.sh + the Mac check: an "archive" (the gate only hashes it) + the restore code from a copy. */
function backupAndVerify(v: ReturnType<typeof vault>, stamp: string): string {
  ensureCanary(v.keysDir);
  const archive = join(v.backupDir, `secrets-${stamp}.tar.age`);
  const copy = join(v.dir, `restored-${stamp}`);
  cpSync(v.keysDir, copy, { recursive: true });
  chmodSync(copy, 0o700);
  writeFileSync(archive, `age-encrypted-bytes-${stamp}`);
  const started = Date.now() + 1;
  recordBackup(v.keysDir, archive, RECIPIENT, started);
  const r = verifyRestoredKeyDir(copy);
  assert.deepEqual(r.problems, []);
  recordVerification(v.db, v.backupDir, `secrets-${stamp}.tar.age`, r.code!);
  return r.code!;
}

test("backup gate: nothing passes without a recipient, a recorded archive and the Mac's verify code", () => {
  const v = vault();
  assert.equal(backupGate(v.db, { ...v.g, recipient: null }).ok, false);
  assert.match(backupGate(v.db, v.g).problems.join(), /no verified backup/);
  ensureCanary(v.keysDir);
  const archive = join(v.backupDir, "secrets-20260926T000000Z.tar.age");
  writeFileSync(archive, "x");
  recordBackup(v.keysDir, archive, RECIPIENT, Date.now() + 1);
  assert.throws(() => recordVerification(v.db, v.backupDir, "secrets-20260926T000000Z.tar.age", "deadbeef.cafe"), /canary/, "a guessed code is refused");
  const canary = readFileSync(join(v.keysDir, "BACKUP-CANARY"), "utf8");
  assert.throws(() => recordVerification(v.db, v.backupDir, "secrets-20260926T000000Z.tar.age", verifyCode(canary, [{ name: "CC001.json", sha256: "0".repeat(64) }])), /different key set/);
  recordVerification(v.db, v.backupDir, "secrets-20260926T000000Z.tar.age", verifyCode(canary, []));
  assert.equal(backupGate(v.db, v.g).ok, true);
  writeFileSync(archive, "tampered");
  assert.match(backupGate(v.db, v.g).problems.join(), /changed on disk/);
});

test("keygen: refused before a verified backup; after it, 0600 files in a 0700 dir; no overwrite; then writes are gated again", () => {
  const v = vault();
  assert.throws(() => generateKeys(v.db, { ...v.g, total: 2 }), KeygenRefused, "no backup yet");
  backupAndVerify(v, "20260926T000001Z");
  const r = generateKeys(v.db, { ...v.g, total: 2 });
  assert.deepEqual(r.created, ["CC001", "CC002"]);
  for (const id of r.created) {
    const st = statSync(join(v.keysDir, `${id}.json`));
    assert.equal(st.mode & 0o777, 0o600);
  }
  assert.equal(statSync(v.keysDir).mode & 0o777, 0o700);
  const keys = listKeys(v.db);
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => k.fake === 0 && k.status === "GENERATED" && k.key_path));
  assert.ok(!JSON.stringify(keys).includes("seed"), "the DB holds did + path only");
  const signers = loadSigners(v.db);
  const s = signers.get("CC001")!;
  assert.ok(verifyEd25519(s.did, s.sign("x"), "x"));
  // the new keys are not in the verified backup: the gate is closed for keygen AND for live writes
  const gate = backupGate(v.db, v.g);
  assert.equal(gate.ok, false);
  assert.match(gate.problems.join(), /not backed up: CC001.json CC002.json/);
  assert.throws(() => generateKeys(v.db, { ...v.g, total: 100 }), KeygenRefused);
  backupAndVerify(v, "20260926T000002Z");
  assert.equal(backupGate(v.db, v.g).ok, true);
  const r2 = generateKeys(v.db, { ...v.g, total: 4 });
  assert.deepEqual(r2.created, ["CC003", "CC004"], "progressive: only the missing keys");
  assert.equal(readFileSync(join(v.keysDir, "CC001.json"), "utf8").length > 0, true);
});

test("keygen refuses a paper database and never overwrites a key file", () => {
  const v = vault();
  backupAndVerify(v, "20260926T000003Z");
  const paper = tmpDb().db;
  ensurePaperKeys(paper, 2);
  assert.throws(() => generateKeys(paper, { ...v.g, total: 2 }), /paper \(fake\) keys/);
  writeFileSync(join(v.keysDir, "CC001.json"), "{}", { mode: 0o600 });
  assert.throws(() => generateKeys(v.db, { ...v.g, total: 2 }), KeygenRefused);
  assert.equal(readFileSync(join(v.keysDir, "CC001.json"), "utf8"), "{}", "untouched");
});

test("restore-verify rejects a corrupted key file and a missing canary", () => {
  const v = vault();
  backupAndVerify(v, "20260926T000004Z");
  generateKeys(v.db, { ...v.g, total: 2 });
  const copy = join(v.dir, "bad");
  cpSync(v.keysDir, copy, { recursive: true });
  chmodSync(copy, 0o700);
  const f = JSON.parse(readFileSync(join(copy, "CC002.json"), "utf8"));
  f.did = listKeys(v.db)[0].did;
  writeFileSync(join(copy, "CC002.json"), JSON.stringify(f), { mode: 0o600 });
  const r = verifyRestoredKeyDir(copy);
  assert.equal(r.code, null);
  assert.match(r.problems.join(), /CC002.json/);
});

test("signed trade: maker and taker signatures verify; taker must be named; qty >= 0.10", () => {
  const m = ephemeralSigner();
  const t = ephemeralSigner();
  const terms: Terms = { id: newTradeId(), maker: m.did, px: "225.00", qty: "0.10", side: "buy", taker: t.did, until: 400 };
  const s = buildSignedTrade(m, t, terms);
  assert.ok(verifyEd25519(m.did, s.makerSig, makerSigningString(terms)));
  assert.ok(verifyEd25519(t.did, s.takerSig, takerSigningString(terms, t.did)));
  assert.ok(s.text.startsWith('{"t":"trade","season":"close-1","terms":{"id":'));
  assert.throws(() => buildSignedTrade(m, t, { ...terms, taker: "any" }), /never "any"/);
  assert.throws(() => buildSignedTrade(m, t, { ...terms, qty: "0.09" }), /at least 0.10/);
  assert.throws(() => buildSignedTrade(t, m, terms), /maker/);
});

test("bootstrap dry-run: 2 keys, then 100, PROTOCOL, mints never listed -- one write per op, test trade settles once", async () => {
  const r = await simulateBootstrap(contest(), { stages: [2, 100], startSweep: 300 });
  assert.ok(r.ok, JSON.stringify(r.checks));
  assert.deepEqual(r.stages.map((s) => s.writes), [6, 99], "2 keys: claim+allow+owner+room+owner+trade; then allow + 98 owners");
  assert.equal(r.server.messages.close1, 2);
});

test("bootstrap dry-run with faults: lost requests, timeouts after commit, a crash after planning, CC001 missed by the referee", async () => {
  const r = await simulateBootstrap(contest(), { stages: [2, 100], startSweep: 300, faults: true, missFirstOwner: true });
  assert.ok(r.ok, JSON.stringify(r.checks));
  assert.equal(r.server.messages.close1, 3, "CC001 owner reposted once (missed) + room");
});

test("STRICT with unlisted mints never promotes by time: CC001 waits forever, nothing else is written", async () => {
  const r = await simulateBootstrap(contest(), { stages: [2], startSweep: 300, policy: "STRICT", maxSteps: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.final.keys.MINT_EXPECTED ?? 0, 1, "protocol evidence is recorded as MINT_EXPECTED (information), never promoted");
  assert.equal(r.final.keys.MINT_CONFIRMED ?? 0, 0);
  assert.equal(r.server.posts, 3, "claim + allow + CC001 owner, then only waiting");
  assert.ok(r.steps.slice(3).every((s) => s.action === "waiting" && s.phase === "wait-first-mint"));
});

function liveBootstrap(srv: MockTechnocore, room = "d-cc-test") {
  const { db } = tmpDb();
  const signers = new Map<string, Signer>();
  for (let i = 1; i <= 2; i++) {
    const s = ephemeralSigner();
    signers.set(keyId(i), s);
    db.prepare("INSERT INTO keys (id, did, key_path, fake, status, updated_at) VALUES (?, ?, NULL, 0, 'GENERATED', ?)").run(keyId(i), s.did, now());
  }
  const c = contest();
  const clock = () => sweepTime(c, 300) + 1000;
  srv.clock = clock;
  const b = new Bootstrap({ db, contest: c, journal: new WriteJournal(db, signers, srv, { clock }), transport: srv, signers, policy: "PROTOCOL", room, clock,
    refreshReferee: async () => {}, gate: () => ({ ok: true, problems: [] }) });
  return { db, b, signers };
}

test("bootstrap halts (room_ownership) on a room someone else owns or that already has messages; writes nothing", async () => {
  const srv = new MockTechnocore();
  const stranger = ephemeralSigner();
  srv.notes.set("room-owners/d-cc-taken", stranger.did);
  const a = liveBootstrap(srv, "d-cc-taken");
  const r = await a.b.step();
  assert.equal(r.action, "halted");
  assert.ok(activeHalts(a.db).room_ownership);
  srv.rooms.set("d-cc-busy", [{ seq: 1, from: stranger.did, text: "hi" }]);
  const b = liveBootstrap(srv, "d-cc-busy");
  assert.equal((await b.b.step()).action, "halted");
  assert.equal(srv.posts, 0);
});

test("bootstrap never overwrites an allow-list holding a foreign DID", async () => {
  const srv = new MockTechnocore();
  const a = liveBootstrap(srv);
  assert.equal((await a.b.step()).phase, "claim");
  srv.notes.set("room-allow/d-cc-test", ephemeralSigner().did);
  const r = await a.b.step();
  assert.equal(r.action, "halted");
  assert.match(r.detail, /not ours/);
  assert.equal(getRoom(a.db, "d-cc-test").status, "CLAIMED");
});

test("bootstrap preflight: a closed backup gate, a missing signer or a halt block every write", async () => {
  const srv = new MockTechnocore();
  const { db } = tmpDb();
  const s = ephemeralSigner();
  db.prepare("INSERT INTO keys (id, did, key_path, fake, status, updated_at) VALUES ('CC001', ?, NULL, 0, 'GENERATED', ?)").run(s.did, now());
  db.prepare("INSERT INTO keys (id, did, key_path, fake, status, updated_at) VALUES ('CC002', ?, NULL, 0, 'GENERATED', ?)").run(ephemeralSigner().did, now());
  const c = contest();
  const b = new Bootstrap({ db, contest: c, journal: new WriteJournal(db, new Map([["CC001", s]]), srv), transport: srv, signers: new Map([["CC001", s]]),
    policy: "PROTOCOL", room: "d-cc-x", clock: () => sweepTime(c, 300), refreshReferee: async () => {}, gate: () => ({ ok: false, problems: ["no verified backup"] }) });
  const r = await b.step();
  assert.equal(r.action, "blocked");
  assert.ok(r.blockers!.some((x) => /CC002: no signer/.test(x)) && r.blockers!.some((x) => /backup gate/.test(x)));
  assert.equal(srv.posts, 0);
  assert.equal(getMeta(db, "halts"), null);
});
