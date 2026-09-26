/**
 * Operational gates, offline: the live-check readiness gate (every row, PASS and each FAIL), the full
 * disaster-recovery drill (backup -> fresh dir -> live-check), the RoomKeeper (refresh, keepalive,
 * foreign allow-list) and halt alerts. Throwaway keys in temp dirs only; fetch is simulated (GET only).
 */

import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureCanary, recordBackup, recordVerification } from "./backup-gate.js";
import { RoomKeeper } from "./bootstrap.js";
import { LIVE_ACK } from "./config.js";
import { WriteJournal } from "./journal.js";
import { keysByRole } from "./keys.js";
import { generateKeys, loadSigners, verifyRestoredKeyDir } from "./live/keygen.js";
import { liveReadiness, renderReadiness } from "./live/readiness.js";
import { disarm, halt } from "./safety.js";
import { backupDb, now, openCloseCallDb, setMeta, type CcDb } from "./store.js";
import { contest, testConfig } from "./test-helpers.js";
import { MockTechnocore } from "./testing/mock-technocore.js";
import { REFEREE_PACKAGE_SHA256 } from "./fold.js";
import { REFEREE_DID } from "./protocol.js";

const C = contest();
const RECIPIENT = "age1" + "q".repeat(58);
const ROOM = "d-cc-ops";

/** A fully prepared live data dir: roles, key files, verified backup, room READY, bootstrap + staging done. */
function prepared(): { dir: string; db: CcDb; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "closecall-live-"));
  chmodSync(dir, 0o700);
  const keys = join(dir, "keys");
  const backups = join(dir, "backups");
  mkdirSync(keys, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  const db = openCloseCallDb(join(dir, "live.sqlite3"));
  chmodSync(join(dir, "live.sqlite3"), 0o600);
  let k = 0;
  const cycle = () => {
    ensureCanary(keys);
    const stamp = `20260926T0000${String(k++).padStart(2, "0")}Z`;
    const a = join(backups, `secrets-${stamp}.tar.age`);
    writeFileSync(a, stamp);
    recordBackup(keys, a, RECIPIENT, Date.now() + 1);
    const c = join(dir, `restored-${stamp}`);
    cpSync(keys, c, { recursive: true });
    chmodSync(c, 0o700);
    recordVerification(db, backups, `secrets-${stamp}.tar.age`, verifyRestoredKeyDir(c).code!);
  };
  cycle();
  const g = { keysDir: keys, backupDir: backups, recipient: RECIPIENT };
  generateKeys(db, { ...g, total: 1, role: "admin" }); cycle();
  generateKeys(db, { ...g, total: 2, role: "staging" }); cycle();
  generateKeys(db, { ...g, total: 4, role: "strategy" }); cycle();
  db.prepare("UPDATE keys SET status = 'READY', minted = 1").run();
  db.prepare("INSERT INTO rooms_state (name, status, owner_did, evidence, updated_at) VALUES (?, 'READY', NULL, '[]', ?)").run(ROOM, now());
  setMeta(db, "bootstrap_done_at", new Date().toISOString());
  setMeta(db, "test_trade_settled", "301");
  setMeta(db, "last_db_backup_at", new Date().toISOString());
  // the referee's signed seed, pinning the official package
  db.prepare("INSERT INTO seed (id, price, tid, time, package, json) VALUES (1, '226.14', '1', 't', ?, '{}')").run(REFEREE_PACKAGE_SHA256);
  db.prepare("INSERT INTO raw_posts (room, seq, generation, ts, from_did, text, fetched_at) VALUES ('d-close1-price', 1, 1, 't', ?, ?, ?)")
    .run(REFEREE_DID, JSON.stringify({ t: "seed", season: "close-1", package: REFEREE_PACKAGE_SHA256 }), now());
  const env = { CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_DATA_DIR: dir, CLOSECALL_DB_PATH: join(dir, "live.sqlite3"),
    CLOSECALL_LIVE_DB_PATH: join(dir, "live.sqlite3"), CLOSECALL_LOCK_PATH: join(dir, "live.lock"), CLOSECALL_ROOM: ROOM, CLOSECALL_BACKUP_AGE_RECIPIENT: RECIPIENT,
    CLOSECALL_LIVE_WRITER: "armed" };
  return { dir, db, env };
}

/** GET-only fake network: technocore config/referee/notes/room, Hyperliquid info. */
function net(db: CcDb, o: { skewMs?: number; serverNonceBump?: bigint; owner?: string } = {}): typeof fetch {
  const admin = keysByRole(db, "admin")[0];
  const others = [...keysByRole(db, "staging"), ...keysByRole(db, "strategy")];
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers({ date: new Date(Date.now() - (o.skewMs ?? 0)).toUTCString() });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers });
    if (init?.method && init.method !== "GET" && !u.includes("hyperliquid")) throw new Error(`non-GET to ${u}`);
    if (u.endsWith("/config")) return json({ version: "0.14.5" });
    if (u.includes("/r/d-close1-price")) return json({ messages: [{ ts: new Date(Date.now() - 30_000).toISOString() }] });
    if (u.includes("hyperliquid")) return json([{ time: Date.now() - 400_000, px: "224.1", tid: 1, coin: "xyz:NVDA" }]);
    if (u.includes("/kv/room-owners/")) return new Response(o.owner ?? admin.did, { status: 200, headers });
    if (u.includes("/kv/room-allow/")) return new Response(others.map((k) => k.did).join(" "), { status: 200, headers });
    if (u.includes(`/r/${ROOM}`)) {
      const local = db.prepare("SELECT last_nonce FROM nonces WHERE signer_id = ? AND scope = ?").get("CC001", `room:${ROOM}`) as { last_nonce: string } | undefined;
      const n = (local ? BigInt(local.last_nonce) : 1000n) + (o.serverNonceBump ?? 0n);
      return new Response(JSON.stringify({ generation: 1, last_seq: 1, messages: [{ seq: 1, from: keysByRole(db, "strategy")[0].did, text: "x", nonce: 0 }] }).replace('"nonce":0', `"nonce":${n}`), { status: 200, headers });
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

const rowsOf = (r: Awaited<ReturnType<typeof liveReadiness>>) => Object.fromEntries(r.rows.map((x) => [x.name, x]));

test("live-check: a fully prepared state PASSES; only GETs are made", async () => {
  const { db, env } = prepared();
  db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
  const r = await liveReadiness(testConfig(env), C, "check", { fetch: net(db), ntp: () => true });
  assert.ok(r.pass, renderReadiness(r));
  const rows = rowsOf(r);
  assert.match(rows["Hyperliquid feed"].value, /feed OK .* last trade 400 s ago \(a quiet market is not a broken feed\)/);
  assert.match(rows["isolation from paper"].value, /all inside/);
});

test("live-check FAILS, with the reason, on each missing condition", async () => {
  const cases: [string, (x: ReturnType<typeof prepared>) => { env?: Record<string, string>; fetch?: typeof fetch; ntp?: boolean }, string][] = [
    ["writer disarmed by config", (x) => ({ env: { ...x.env, CLOSECALL_LIVE_WRITER: "disarmed" } }), "writer"],
    ["kill switch", (x) => { disarm(x.dir, "operator"); return {}; }, "writer"],
    ["NTP not synchronized", () => ({ ntp: false }), "NTP"],
    ["clock skew 5 s", (x) => ({ fetch: net(x.db, { skewMs: 5_000 }) }), "clock skew"],
    ["server nonce ahead of our journal (restored from an old backup)", (x) => ({ fetch: net(x.db, { serverNonceBump: 10n }) }), "nonce reconciliation"],
    ["room owned by someone else", (x) => ({ fetch: net(x.db, { owner: "did:key:z6MkSomeoneElse" }) }), "room on server"],
    ["paper data dir", (x) => ({ env: { ...x.env, CLOSECALL_DATA_DIR: "/var/lib/flop-closecall" } }), "isolation from paper"],
    ["loose key file", (x) => { chmodSync(join(x.dir, "keys", "CC001.json"), 0o644); return {}; }, "key dir perms"],
    ["key added after the backup", (x) => { writeFileSync(join(x.dir, "keys", "CC005.json"), "{}", { mode: 0o600 }); return {}; }, "restore verification"],
    ["staging trade not settled", (x) => { x.db.prepare("DELETE FROM meta WHERE key = 'test_trade_settled'").run(); return {}; }, "staging trade"],
    ["referee seed pins another package", (x) => { x.db.prepare("UPDATE seed SET package = 'f00d'").run(); return {}; }, "referee seed"],
    ["UNKNOWN trade", (x) => { x.db.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, maker_id, taker_id, terms, payload_sha256, state, created_at, updated_at)
      VALUES ('i', 't', 1, 'CC001', 'CC002', '{}', 'x', 'UNKNOWN', ?, ?)`).run(now(), now()); return {}; }, "unknown trades"],
  ];
  for (const [name, mutate, row] of cases) {
    const x = prepared();
    x.db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
    const m = mutate(x);
    const r = await liveReadiness(testConfig(m.env ?? x.env), C, "check", { fetch: m.fetch ?? net(x.db), ntp: () => m.ntp ?? true });
    assert.equal(r.pass, false, name);
    assert.equal(rowsOf(r)[row]?.ok, false, `${name}: row ${row}\n${renderReadiness(r)}`);
  }
});

test("live run tolerates what it must reconcile (pending writes, UNKNOWN, halts) but check does not", async () => {
  const x = prepared();
  x.db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
  halt(x.db, "ambiguous_operation", "trade t: unknown");
  const opts = { fetch: net(x.db), ntp: () => true };
  assert.equal((await liveReadiness(testConfig(x.env), C, "check", opts)).pass, false);
  assert.equal((await liveReadiness(testConfig(x.env), C, "run", opts)).pass, true, "the service starts, reconciles read-only, and stays halted for new entries");
});

test("disaster recovery drill: backup -> brand-new dir -> live-check --offline PASSES; nothing written anywhere else", async () => {
  const x = prepared();
  x.db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
  x.db.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, maker_id, taker_id, terms, payload_sha256, state, created_at, updated_at)
    VALUES ('i1', 'abc', 5, 'CC001', 'CC002', '{}', 'x', 'SETTLED', ?, ?)`).run(now(), now());
  const snap = join(x.dir, "backups", "close-call-drill.sqlite3");
  await backupDb(x.db, snap);
  // "decrypt" the archive into a fresh dir: keys + DB snapshot, plus the pulled backups folder
  const drill = mkdtempSync(join(tmpdir(), "closecall-drill-"));
  chmodSync(drill, 0o700);
  cpSync(join(x.dir, "keys"), join(drill, "keys"), { recursive: true });
  chmodSync(join(drill, "keys"), 0o700);
  cpSync(snap, join(drill, "live.sqlite3"));
  chmodSync(join(drill, "live.sqlite3"), 0o600);
  mkdirSync(join(drill, "backups"), { mode: 0o700 });
  for (const f of readdirSync(join(x.dir, "backups")).filter((f) => f.startsWith("secrets-"))) cpSync(join(x.dir, "backups", f), join(drill, "backups", f));
  const env = { ...x.env, CLOSECALL_DATA_DIR: drill, CLOSECALL_DB_PATH: join(drill, "live.sqlite3"), CLOSECALL_LIVE_DB_PATH: join(drill, "live.sqlite3"), CLOSECALL_LOCK_PATH: join(drill, "live.lock") };
  // key_path still names the OLD dir: keys load by id from the CURRENT keys dir, nothing is rewritten
  const rdb = openCloseCallDb(join(drill, "live.sqlite3"));
  assert.equal(loadSigners(rdb, join(drill, "keys")).size, 7, "every key reloads and self-tests from the restored files");
  assert.equal((rdb.prepare("SELECT state FROM live_trades WHERE trade_id = 'abc'").get() as { state: string }).state, "SETTLED", "journal restored");
  assert.equal((rdb.prepare("SELECT last_nonce FROM nonces WHERE signer_id = 'CC001'").get() as { last_nonce: string }).last_nonce, "5000", "nonces restored");
  rdb.close();
  const r = await liveReadiness(testConfig(env), C, "check", { offline: true });
  assert.ok(r.pass, renderReadiness(r));
});

test("RoomKeeper: 5-day refresh (CAS, current values), 48 h keepalive, foreign allow-list -> grave halt with an alert", async () => {
  const x = prepared();
  const signers = loadSigners(x.db, join(x.dir, "keys"));
  const srv = new MockTechnocore();
  let t = Date.parse("2026-09-27T00:00:00Z");
  srv.clock = () => t;
  const admin = keysByRole(x.db, "admin")[0];
  const others = [...keysByRole(x.db, "staging"), ...keysByRole(x.db, "strategy")];
  srv.notes.set(`room-owners/${ROOM}`, admin.did);
  srv.notes.set(`room-allow/${ROOM}`, others.map((k) => k.did).join(" "));
  srv.notes.set(`room-nonce/${ROOM}`, "1");
  srv.rooms.set(ROOM, [{ seq: 1, from: others[0].did, text: "a", ts: new Date(t).toISOString() }, { seq: 2, from: others[1].did, text: "b", ts: new Date(t).toISOString() }]);
  setMeta(x.db, "bootstrap_done_at", new Date(t).toISOString());
  const keeper = new RoomKeeper({ db: x.db, journal: new WriteJournal(x.db, signers, srv, { clock: () => t }), transport: srv, room: ROOM, clock: () => t });
  assert.deepEqual(await keeper.tick(), { ok: true, detail: `owner + allow-list ours, 2 messages`, wrote: 0 });
  t += 49 * 3_600_000;                                                        // 49 h idle -> keepalive
  assert.equal((await keeper.tick()).wrote, 1);
  assert.match(srv.rooms.get(ROOM)!.at(-1)!.text, /^close-call keepalive /);
  t += 4 * 86_400_000;                                                        // day 6 -> refresh both notes (+ keepalive)
  const r = await keeper.tick();
  assert.ok(r.wrote >= 2);
  assert.equal(srv.notes.get(`room-owners/${ROOM}`), admin.did);
  assert.equal(srv.notes.get(`room-allow/${ROOM}`), others.map((k) => k.did).join(" "), "same values re-signed");
  srv.notes.set(`room-allow/${ROOM}`, `${srv.notes.get(`room-allow/${ROOM}`)} did:key:z6MkForeign`);
  const bad = await keeper.tick();
  assert.equal(bad.ok, false);
  assert.ok(x.db.prepare("SELECT 1 FROM alerts WHERE message LIKE 'HALTED: room_ownership%'").get(), "alert recorded");
});

// ---------------------------------------------------------------- BUG 1: restore into ANOTHER data dir (A -> B, A deleted)

import { rmSync as _rm, existsSync as _exists } from "node:fs";
import { restoreDrill, renderDrill } from "./live/restore-drill.js";
import { verifyEd25519 } from "../identity.js";

test("BUG 1: a live backup restores into another data dir; nothing depends on the original path; the archive's own metadata is reconstructed", async () => {
  // ---- A: production-like live dir with a throwaway CC-ADMIN, following the real backup order
  const A = mkdtempSync(join(tmpdir(), "closecall-A-"));
  chmodSync(A, 0o700);
  const keysA = join(A, "keys"), backupsA = join(A, "backups");
  mkdirSync(keysA, { mode: 0o700 }); mkdirSync(backupsA, { mode: 0o700 });
  const dbA = openCloseCallDb(join(A, "live.sqlite3"));
  ensureCanary(keysA);
  const arch0 = join(backupsA, "secrets-20260926T100000Z.tar.age");
  writeFileSync(arch0, "archive-0");
  recordBackup(keysA, arch0, RECIPIENT, Date.now() + 1);
  const c0 = join(A, "r0"); cpSync(keysA, c0, { recursive: true }); chmodSync(c0, 0o700);
  recordVerification(dbA, backupsA, "secrets-20260926T100000Z.tar.age", verifyRestoredKeyDir(c0).code!);
  generateKeys(dbA, { keysDir: keysA, backupDir: backupsA, recipient: RECIPIENT, total: 1, role: "admin" });
  const adminDid = (dbA.prepare("SELECT did FROM keys WHERE id = 'CC-ADMIN'").get() as { did: string }).did;
  assert.equal((dbA.prepare("SELECT key_path FROM keys WHERE id = 'CC-ADMIN'").get() as { key_path: string }).key_path, join(keysA, "CC-ADMIN.json"), "the stored path names A");
  // closecall-backup.sh order: DB snapshot -> tar(keys, env, snapshot) | age -> record-backup (manifest) ... verification comes LATER
  const snap = join(backupsA, "close-call-snap.sqlite3");
  await backupDb(dbA, snap);
  const arch1 = join(backupsA, "secrets-20260926T110000Z.tar.age");
  writeFileSync(arch1, "archive-1 (age bytes)");
  recordBackup(keysA, arch1, RECIPIENT, Date.now() + 1);
  dbA.close();

  // ---- "decrypt" into B on another machine: keys + the snapshot inside the archive + the pulled archives/manifests
  const B = mkdtempSync(join(tmpdir(), "closecall-B-"));
  chmodSync(B, 0o700);
  cpSync(keysA, join(B, "keys"), { recursive: true }); chmodSync(join(B, "keys"), 0o700);
  cpSync(snap, join(B, "live.sqlite3")); chmodSync(join(B, "live.sqlite3"), 0o600);
  mkdirSync(join(B, "backups"), { mode: 0o700 });
  for (const f of ["secrets-20260926T100000Z", "secrets-20260926T110000Z"]) for (const ext of [".tar.age", ".manifest.json"]) cpSync(join(backupsA, f + ext), join(B, "backups", f + ext));
  _rm(A, { recursive: true, force: true });
  assert.equal(_exists(A), false, "A no longer exists");

  const envB = { CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_DATA_DIR: B, CLOSECALL_DB_PATH: join(B, "live.sqlite3"),
    CLOSECALL_LIVE_DB_PATH: join(B, "live.sqlite3"), CLOSECALL_LOCK_PATH: join(B, "live.lock"), CLOSECALL_ROOM: "d-cc-restore", CLOSECALL_BACKUP_AGE_RECIPIENT: RECIPIENT };
  const r = restoreDrill(testConfig(envB), join(B, "backups", "secrets-20260926T110000Z.tar.age"));
  const sec = Object.fromEntries(r.sections.map((s) => [s.name, s]));
  assert.ok(r.pass, renderDrill(r));
  for (const n of ["RESTORE INTEGRITY", "KEY SELF-TEST", "KEY PATH REMAP", "DB RESTORE", "STRATEGY STATE", "JOURNAL", "NONCES"]) assert.equal(sec[n].status, "PASS", `${n}: ${sec[n].detail}`);
  assert.equal(sec["BACKUP METADATA"].status, "RECONSTRUCTED", sec["BACKUP METADATA"].detail);
  assert.match(sec["BACKUP METADATA"].detail, /previous verification \(secrets-20260926T100000Z/);
  assert.equal(sec["NETWORK GATES"].status, "SKIPPED");
  assert.match(sec.ROOM.detail, /UNCONFIGURED \(not yet bootstrapped\)/);
  assert.match(sec["KEY PATH REMAP"].detail, /^1 stored key_path/);
  // CC-ADMIN loads from B, same DID, signs and verifies
  const dbB = openCloseCallDb(join(B, "live.sqlite3"));
  const s = loadSigners(dbB, join(B, "keys")).get("CC-ADMIN")!;
  assert.equal(s.did, adminDid);
  assert.ok(verifyEd25519(s.did, s.sign("restore"), "restore"));
  dbB.close();
  assert.ok(!renderDrill(r).includes(A), "no reference to the original data dir in the drill output");
});

// ---------------------------------------------------------------- BUG 2: virgin room vs deleted room

/** A virgin room exactly as technocore answers it (captured 26 Sep for d-cc-e7a0f95273a7): 404 notes with a text body. */
function virginNet(db: CcDb, room: string, base: typeof fetch): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    for (const ns of ["room-owners", "room-allow", "room-nonce"]) {
      if (u.endsWith(`/kv/${ns}/${room}`)) return new Response(`[untrusted note content follows]\n\n404: no note ${ns}/${room}\nsee https://technocore.chat/llms.txt for the note API and namespaces\n`, { status: 404 });
    }
    if (u.includes(`/r/${room}?format=json`) && u.includes("limit=1")) return new Response(JSON.stringify({ room, count: 0, first_seq: null, last_seq: 0, generation: 0, messages: [] }), { status: 200 });
    if (u.includes(`/r/${room}`)) return new Response(JSON.stringify({ room, count: 0, first_seq: null, last_seq: 0, generation: 0, messages: [] }), { status: 200 });
    return base(url, init);
  }) as unknown as typeof fetch;
}

test("BUG 2: a VIRGIN room (all 404, generation 0, no messages) is VIRGIN -- 0 foreign DIDs, no false deletion; OK before the bootstrap", async () => {
  const x = prepared();
  const room = "d-cc-e7a0f95273a7";
  x.db.prepare("DELETE FROM rooms_state").run();
  const env = { ...x.env, CLOSECALL_ROOM: room };
  const f = virginNet(x.db, room, net(x.db));
  const boot = rowsOf(await liveReadiness(testConfig(env), C, "bootstrap", { fetch: f, ntp: () => true }));
  assert.equal(boot["room on server"].ok, true, boot["room on server"].value);
  assert.match(boot["room on server"].value, /^VIRGIN \(not created\): owner ABSENT, allow ABSENT, nonce ABSENT, messages 0, generation 0$/);
  assert.equal(boot["room generation"].ok, true);
  assert.match(boot["room generation"].value, /NOT CREATED/);
  const check = rowsOf(await liveReadiness(testConfig(env), C, "check", { fetch: f, ntp: () => true }));
  assert.equal(check["room on server"].ok, false, "a virgin room is not a READY live room");
  for (const r of Object.values(check)) assert.ok(!/foreign|deleted/i.test(r.value), `${r.name}: ${r.value}`);
});

test("BUG 2: a room WE configured (recorded generation) that now reads empty/absent is DELETED / GENERATION LOST -> FAIL in every stage", async () => {
  const x = prepared();
  const room = "d-cc-was-ours";
  x.db.prepare("UPDATE rooms_state SET name = ?").run(room);
  x.db.prepare("INSERT INTO meta (key, value) VALUES (?, '3')").run(`room_generation:${room}`);
  const env = { ...x.env, CLOSECALL_ROOM: room };
  const f = virginNet(x.db, room, net(x.db));
  for (const stage of ["bootstrap", "check"] as const) {
    const rows = rowsOf(await liveReadiness(testConfig(env), C, stage, { fetch: f, ntp: () => true }));
    assert.equal(rows["room on server"].ok, false, stage);
    assert.match(rows["room on server"].value, /DELETED \/ GENERATION LOST/);
    assert.equal(rows["room generation"].ok, false);
    assert.match(rows["room generation"].value, /GENERATION LOST: recorded 3, server 0/);
  }
});

test("classifyRoom: virgin / ours / foreign / deleted / unclaimable", async () => {
  const { classifyRoom } = await import("./readiness.js");
  const ours = new Set(["did:a", "did:b"]);
  const base = { owner: null, allow: null, nonce: null, lastSeq: 0, generation: 0, adminDid: "did:admin", ourDids: ours, storedGeneration: null, everConfigured: false };
  assert.equal(classifyRoom(base).state, "VIRGIN");
  assert.equal(classifyRoom({ ...base, owner: "did:admin", allow: "did:a did:b", nonce: "5", lastSeq: 4, generation: 1, storedGeneration: 1, everConfigured: true }).state, "OURS");
  assert.equal(classifyRoom({ ...base, owner: "did:admin", allow: "did:a did:x", lastSeq: 4, generation: 1, everConfigured: true }).foreign, 1);
  assert.equal(classifyRoom({ ...base, owner: "did:other", lastSeq: 1, generation: 1 }).state, "FOREIGN");
  assert.equal(classifyRoom({ ...base, storedGeneration: 2, everConfigured: true }).state, "DELETED");
  assert.equal(classifyRoom({ ...base, owner: "did:admin", lastSeq: 9, generation: 3, storedGeneration: 2, everConfigured: true }).generationOk, false, "generation changed");
  assert.equal(classifyRoom({ ...base, lastSeq: 3, generation: 1 }).state, "UNCLAIMABLE");
});

test("pre-staging gate (FASE 3): admin + 2 staging just generated, virgin room, writer DISARMED -> --stage bootstrap PASSES; the final check does not", async () => {
  const x = prepared();
  const room = "d-cc-e7a0f95273a7";
  x.db.prepare("DELETE FROM rooms_state").run();
  x.db.prepare("UPDATE keys SET status = 'GENERATED', registered = 0, minted = 0").run();
  x.db.prepare("DELETE FROM keys WHERE role = 'strategy'").run();
  for (const k of ["bootstrap_done_at", "test_trade_settled"]) x.db.prepare("DELETE FROM meta WHERE key = ?").run(k);
  for (const f of readdirSync(join(x.dir, "keys")).filter((f) => /^CC\d{3}\.json$/.test(f))) _rm(join(x.dir, "keys", f));
  // re-verify a backup of exactly the remaining 3 key files (as FASE 2 does)
  const stamp = "20260926T200000Z";
  const a = join(x.dir, "backups", `secrets-${stamp}.tar.age`);
  writeFileSync(a, stamp);
  recordBackup(join(x.dir, "keys"), a, RECIPIENT, Date.now() + 1);
  const c = join(x.dir, "rstage"); cpSync(join(x.dir, "keys"), c, { recursive: true }); chmodSync(c, 0o700);
  recordVerification(x.db, join(x.dir, "backups"), `secrets-${stamp}.tar.age`, verifyRestoredKeyDir(c).code!);
  const env = { ...x.env, CLOSECALL_ROOM: room, CLOSECALL_LIVE_WRITER: "disarmed" };
  const f = virginNet(x.db, room, net(x.db));
  const boot = await liveReadiness(testConfig(env), C, "bootstrap", { fetch: f, ntp: () => true });
  assert.ok(boot.pass, renderReadiness(boot));
  const rows = rowsOf(boot);
  assert.equal(rows.writer.ok, false, "writer shown DISARMED (not required yet)");
  assert.match(rows["staging keys"].value, /CC-TEST-001:GENERATED CC-TEST-002:GENERATED/);
  assert.equal((await liveReadiness(testConfig(env), C, "check", { fetch: f, ntp: () => true })).pass, false, "the final gate needs the bootstrap done");
});
