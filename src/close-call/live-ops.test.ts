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
import { halt } from "./safety.js";
import { backupDb, now, openCloseCallDb, setMeta, type CcDb } from "./store.js";
import { contest, testConfig } from "./test-helpers.js";
import { MockTechnocore } from "./testing/mock-technocore.js";

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
  const env = { CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_DATA_DIR: dir, CLOSECALL_DB_PATH: join(dir, "live.sqlite3"),
    CLOSECALL_LIVE_DB_PATH: join(dir, "live.sqlite3"), CLOSECALL_LOCK_PATH: join(dir, "live.lock"), CLOSECALL_ROOM: ROOM, CLOSECALL_BACKUP_AGE_RECIPIENT: RECIPIENT };
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
      return new Response(JSON.stringify({ messages: [{ seq: 1, from: keysByRole(db, "strategy")[0].did, text: "x", nonce: 0 }] }).replace('"nonce":0', `"nonce":${n}`), { status: 200, headers });
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

const rowsOf = (r: Awaited<ReturnType<typeof liveReadiness>>) => Object.fromEntries(r.rows.map((x) => [x.name, x]));

test("live-check: a fully prepared state PASSES; only GETs are made", async () => {
  const { db, env } = prepared();
  db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
  const r = await liveReadiness(testConfig(env), C, true, "check", { fetch: net(db), ntp: () => true });
  assert.ok(r.pass, renderReadiness(r));
  const rows = rowsOf(r);
  assert.match(rows["Hyperliquid feed"].value, /feed OK .* last trade 400 s ago \(a quiet market is not a broken feed\)/);
  assert.match(rows["isolation from paper"].value, /all inside/);
});

test("live-check FAILS, with the reason, on each missing condition", async () => {
  const cases: [string, (x: ReturnType<typeof prepared>) => { env?: Record<string, string>; fetch?: typeof fetch; ntp?: boolean; writer?: boolean }, string][] = [
    ["writer not connected", () => ({ writer: false }), "writer"],
    ["NTP not synchronized", () => ({ ntp: false }), "clock (NTP)"],
    ["clock skew 5 s", (x) => ({ fetch: net(x.db, { skewMs: 5_000 }) }), "clock (NTP)"],
    ["server nonce ahead of our journal (restored from an old backup)", (x) => ({ fetch: net(x.db, { serverNonceBump: 10n }) }), "nonce reconciliation"],
    ["room owned by someone else", (x) => ({ fetch: net(x.db, { owner: "did:key:z6MkSomeoneElse" }) }), "room on server"],
    ["paper data dir", (x) => ({ env: { ...x.env, CLOSECALL_DATA_DIR: "/var/lib/flop-closecall" } }), "isolation from paper"],
    ["loose key file", (x) => { chmodSync(join(x.dir, "keys", "CC001.json"), 0o644); return {}; }, "key dir perms"],
    ["key added after the backup", (x) => { writeFileSync(join(x.dir, "keys", "CC005.json"), "{}", { mode: 0o600 }); return {}; }, "restore verification"],
    ["staging trade not settled", (x) => { x.db.prepare("DELETE FROM meta WHERE key = 'test_trade_settled'").run(); return {}; }, "staging trade"],
    ["UNKNOWN trade", (x) => { x.db.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, maker_id, taker_id, terms, payload_sha256, state, created_at, updated_at)
      VALUES ('i', 't', 1, 'CC001', 'CC002', '{}', 'x', 'UNKNOWN', ?, ?)`).run(now(), now()); return {}; }, "unknown trades"],
  ];
  for (const [name, mutate, row] of cases) {
    const x = prepared();
    x.db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
    const m = mutate(x);
    const r = await liveReadiness(testConfig(m.env ?? x.env), C, m.writer ?? true, "check", { fetch: m.fetch ?? net(x.db), ntp: () => m.ntp ?? true });
    assert.equal(r.pass, false, name);
    assert.equal(rowsOf(r)[row]?.ok, false, `${name}: row ${row}\n${renderReadiness(r)}`);
  }
});

test("live run tolerates what it must reconcile (pending writes, UNKNOWN, halts) but check does not", async () => {
  const x = prepared();
  x.db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${ROOM}`, now());
  halt(x.db, "ambiguous_operation", "trade t: unknown");
  const opts = { fetch: net(x.db), ntp: () => true };
  assert.equal((await liveReadiness(testConfig(x.env), C, true, "check", opts)).pass, false);
  assert.equal((await liveReadiness(testConfig(x.env), C, true, "run", opts)).pass, true, "the service starts, reconciles read-only, and stays halted for new entries");
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
  // keys point at their old paths: a restore rewrites key_path to the new dir
  const rdb = openCloseCallDb(join(drill, "live.sqlite3"));
  rdb.prepare("UPDATE keys SET key_path = ? || '/' || id || '.json'").run(join(drill, "keys"));
  assert.equal(loadSigners(rdb).size, 7, "every key reloads and self-tests from the restored files");
  assert.equal((rdb.prepare("SELECT state FROM live_trades WHERE trade_id = 'abc'").get() as { state: string }).state, "SETTLED", "journal restored");
  assert.equal((rdb.prepare("SELECT last_nonce FROM nonces WHERE signer_id = 'CC001'").get() as { last_nonce: string }).last_nonce, "5000", "nonces restored");
  rdb.close();
  const r = await liveReadiness(testConfig(env), C, true, "check", { offline: true });
  assert.ok(r.pass, renderReadiness(r));
});

test("RoomKeeper: 5-day refresh (CAS, current values), 48 h keepalive, foreign allow-list -> grave halt with an alert", async () => {
  const x = prepared();
  const signers = loadSigners(x.db);
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
