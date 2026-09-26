/**
 * Terminal monitor: every state renders, nothing is ever written, missing data shows N/A.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LIVE_ACK } from "./config.js";
import { sweepTime } from "./contest.js";
import type { Health } from "./health.js";
import { ensurePaperKeys, keyId } from "./keys.js";
import { collect, render, stripAnsi, type MonitorSources, type SystemdInfo } from "./monitor.js";
import { halt } from "./safety.js";
import { now, openCloseCallDb, type CcDb } from "./store.js";
import { contest, RefereeFeed, testConfig, tmpDb } from "./test-helpers.js";

const C = contest();
const N = 140;
const T = sweepTime(C, N) + 30_000;           // 30 s after sweep 140's boundary

const SD_UP: SystemdInfo = { active: "active", sub: "running", pid: 4242, restarts: 2, since: T - 3_600_000, memoryMb: 80, cpuNs: 36e9 };
const SD_DOWN: SystemdInfo = { active: "inactive", sub: "dead", pid: null, restarts: 2, since: null, memoryMb: null, cpuNs: null };

function healthDoc(mode = "paper"): Health {
  return { status: "ok", mode, process: { pid: 4242, uptime_s: 3600, rss_mb: 71.5, heap_mb: 12, lock: { present: true, held: true, info: null } },
    sweep: { current_by_clock: N, last_received: N, seconds_since_referee_update: 20, referee_delay_min: 0, last_age_s: 12 },
    hyperliquid: { last_px: "225.30", age_s: 5 }, db: { ok: true, path: "", size_mb: 3, schema_version: 3 }, disk: { free_mb: 9000, low: false },
    observer: "running", strategy: "running", executor: "paper", execution_halted: false, halts: [], reconciliation: { l1: "OK @140", l2: "OK" },
    keys: {}, pending_writes: 0, unresolved_trades: 0, last_error: null, counters: { reconnects: 1, timeouts: 0, alerts_24h: 0 } };
}

/** A paper database with two published sweeps, HL trades, keys, positions, intents and reconcile rows. */
function fixture(opts: { ageS?: number; hlAgeS?: number; keys?: number } = {}): { db: CcDb; dir: string; path: string } {
  const { db, dir } = tmpDb();
  const feed = new RefereeFeed(db);
  for (const [n, px] of [[N - 1, "225.10"], [N, "225.20"]] as const) {
    feed.post("d-close1-price", { t: "price", n, ref: { px, tid: n, time: new Date(sweepTime(C, n) - 1000).toISOString() }, limits: ["213.94", "236.46"], global: "225.00", file: `f${n}`, age_s: n === N ? opts.ageS ?? 12 : 5 });
    feed.post("d-close1-flow", { t: "flow", n, mints: [], rooms: [], settled: [], void: [], missed: [], file: `f${n}` });
  }
  feed.post("d-close1-pnl", { t: "pnl", n: N, mark: "225.00", top: [["did:key:z6MkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA11111111", "91.28"], ["did:key:z6MkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB22222222", "88.14"]], file: "p" });
  db.prepare("INSERT INTO hl_trades (tid, px, time_ms, observed_at_ms) VALUES ('1', '225.31', ?, ?)").run(T - (opts.hlAgeS ?? 3) * 1000, T - 2000);
  if ((opts.keys ?? 100) > 0) ensurePaperKeys(db, opts.keys ?? 100);
  db.prepare("UPDATE keys SET status = 'READY'").run();
  db.prepare("UPDATE keys SET status = 'ACTIVE', entry_px = '224.54' WHERE id IN ('CC001','CC002')").run();
  if ((opts.keys ?? 100) >= 2) {
    db.prepare("INSERT INTO positions (n, key_id, book, cash, position, fees, value, mark, at) VALUES (?, 'CC001', 'paper', '100', '43.21', '97.1', '10083.42', '225.2', ?)").run(N, now());
    db.prepare("INSERT INTO positions (n, key_id, book, cash, position, fees, value, mark, at) VALUES (?, 'CC002', 'paper', '19800', '-43.21', '85.2', '9900.10', '225.2', ?)").run(N, now());
    db.prepare(`INSERT INTO intents (intent_id, sweep, pair_index, trigger, favored, maker_id, taker_id, side, qty, px, trade_id, risk_status, outcome, actual_maker_fee, actual_taker_fee, created_at)
      VALUES ('i1', ?, 0, 'open-split-long', 'long', 'CC001', 'CC002', 'buy', '43.21', '224.54', 'abcdef0123456789abcdef0123456789', 'OK', 'settled', '97.1', '85.2', ?)`).run(N - 1, now());
  }
  db.prepare("INSERT INTO reconcile (n, level, status, detail, at) VALUES (?, 'L1-referee', 'OK', '{}', ?)").run(N, now());
  db.prepare("INSERT INTO reconcile (n, level, status, detail, at) VALUES (?, 'L2-books-settle', 'OK', '{}', ?)").run(N, now());
  db.prepare("INSERT INTO strategy_state (name, json, updated_at) VALUES ('K', ?, ?)").run(JSON.stringify({ name: "K", started: true, lo: 224.61, hi: 226.11, nextPair: 4 }), now());
  db.prepare("INSERT INTO strategy_triggers (sweep, strategy, trigger, pair_index, estimate, policy, decision, detail, at) VALUES (?, 'K', 'new-low', 3, '224.61', 'TRADE', 'open pair favouring long', '{}', ?)").run(N - 1, now());
  return { db, dir, path: join(dir, "cc.sqlite3") };
}

function src(path: string, dir: string, o: { sd?: SystemdInfo | null; health?: Health | null; env?: Record<string, string> } = {}): MonitorSources {
  return {
    cfg: testConfig({ CLOSECALL_DATA_DIR: dir, CLOSECALL_DB_PATH: path, ...(o.env ?? {}) }), contest: C, now: T,
    systemd: () => (o.sd === undefined ? SD_UP : o.sd), fetchHealth: async () => (o.health === undefined ? healthDoc() : o.health), version: () => "v0.1.0 test123",
  };
}

const text = async (s: MonitorSources, color = false) => render(await collect(s), { color, width: 100 });

test("paper: title, WRITES DISABLED, fake keys, simulated trades, market and strategy data", async () => {
  const f = fixture();
  const out = await text(src(f.path, f.dir));
  for (const s of ["CLOSE CALL — PAPER", "WRITES: DISABLED", "FAKE KEYS", "TRADES (SIMULATED)", "SERVICE", "OK", "PID                4242",
    "225.31", "REF (139)          225.10", "CLOSE (140)        225.20", "HL vs CLOSE        +4.9 bps", "READY", "ACTIVE", "CC001", "+83.42",
    "#1 …11111111", "+91.28", "next low           224.05", "next high          226.68", "pairs used         4", "pairs unused       46",
    "CC001 -> CC002", "SETTLED", "L1                 OK @140", "reconnects         1", "safe mode          NO", "restarts           2", "v0.1.0 test123"]) {
    assert.ok(out.includes(s), `missing: ${s}\n${out}`);
  }
  assert.ok(!out.includes("SERVICE DOWN"));
  assert.match(out, /our global rank\s+N\/A/);
});

test("live (simulated): LIVE title, WRITES ENABLED, REAL KEYS, real trades from the live DB", async () => {
  const f = fixture({ keys: 0 });
  const livePath = join(f.dir, "live.sqlite3");
  const live = openCloseCallDb(livePath);
  for (let i = 1; i <= 2; i++) live.prepare("INSERT INTO keys (id, did, key_path, fake, status, updated_at) VALUES (?, ?, '/k', 0, 'READY', ?)").run(keyId(i), `did:key:z6Mk${String(i).repeat(44)}`, now());
  live.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, pair_index, maker_id, taker_id, terms, payload_sha256, state, created_at, updated_at)
    VALUES ('i-live', 'feedbeef00112233', ?, 0, 'CC001', 'CC002', '{}', 'x', 'POSTED', ?, ?)`).run(N, now(), now());
  const out = await text(src(f.path, f.dir, { env: { CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_LIVE_DB_PATH: livePath, CLOSECALL_LIVE_WRITER: "armed" }, health: healthDoc("live") }));
  for (const s of ["CLOSE CALL — LIVE", "WRITES: ENABLED", "REAL KEYS", "TRADES (REAL)", "feedbeef", "POSTED", "pending            1"]) assert.ok(out.includes(s), `missing: ${s}`);
  assert.ok(!out.includes("FAKE KEYS") && !out.includes("WRITES: DISABLED"));
});

test("service down: SERVICE DOWN, but everything readable from SQLite is still shown", async () => {
  const f = fixture();
  const out = await text(src(f.path, f.dir, { sd: SD_DOWN, health: null }));
  assert.ok(out.includes("SERVICE DOWN"));
  assert.match(out, /strategy\s+STOPPED/);
  assert.match(out, /executor\s+stopped/);
  assert.ok(out.includes("CLOSE (140)        225.20") && out.includes("CC001"));
  assert.match(out, /reconnects\s+N\/A/);
});

test("referee stale: age_s over the limit is flagged and the stale policy halts new entries", async () => {
  const f = fixture({ ageS: 400 });
  const out = await text(src(f.path, f.dir));
  assert.match(out, /age_s\s+400s STALE/);
  assert.match(out, /stale policy\s+HALT_NEW_ENTRIES/);
});

test("Hyperliquid: an old LAST TRADE with a healthy FEED is OK; a stale FEED is flagged", async () => {
  const f = fixture({ hlAgeS: 900 });
  f.db.prepare("INSERT INTO meta (key, value) VALUES ('hl_feed_ok_at', ?)").run(String(T - 2_000));
  const out = await text(src(f.path, f.dir));
  assert.match(out, /last_trade_age\s+900s/);
  assert.match(out, /feed_health_age\s+2s/);
  assert.match(out, /feed status\s+OK/);
  f.db.prepare("UPDATE meta SET value = ? WHERE key = 'hl_feed_ok_at'").run(String(T - 700_000));
  assert.match(await text(src(f.path, f.dir)), /feed status\s+DOWN \(halt\)/);
});

test("HALTED: banner, safe mode YES, the reason and the unhalt code", async () => {
  const f = fixture();
  const h = halt(f.db, "reconcile_mismatch", "L2 intent mismatch at sweep 140");
  const out = await text(src(f.path, f.dir));
  assert.ok(out.includes("HALTED: reconcile_mismatch"));
  assert.match(out, /safe mode\s+YES/);
  assert.match(out, /execution halted\s+YES/);
  assert.ok(out.includes(`unhalt --code ${h.code}`));
  assert.match(out, /strategy\s+HALTED/);
});

test("keys in ERROR are counted; no keys shows 0 (no keys)", async () => {
  const f = fixture();
  f.db.prepare("UPDATE keys SET status = 'ERROR' WHERE id = 'CC050'").run();
  assert.match(await text(src(f.path, f.dir)), /^ {2}ERROR\s+1(\s|$)/m);
  const g = fixture({ keys: 0 });
  assert.ok((await text(src(g.path, g.dir))).includes("0 (no keys)"));
});

test("pending trade: counted as pending / unresolved and shown as PENDING", async () => {
  const f = fixture();
  f.db.prepare(`INSERT INTO intents (intent_id, sweep, favored, maker_id, taker_id, qty, px, trade_id, risk_status, created_at)
    VALUES ('i2', ?, 'short', 'CC003', 'CC004', '10.00', '226.00', '99887766554433221100', 'OK', ?)`).run(N, new Date(Date.now() + 1000).toISOString());
  const out = await text(src(f.path, f.dir));
  assert.match(out, /pending\s+1/);
  assert.match(out, /unresolved trades\s+1/);
  assert.ok(out.includes("PENDING"));
});

test("missing metrics: an empty database renders N/A everywhere, never throws", async () => {
  const { dir } = tmpDb();
  const out = await text(src(join(dir, "cc.sqlite3"), dir, { sd: null, health: null }));
  assert.ok(out.includes("CLOSE CALL — PAPER"));
  assert.match(out, /NVDA\s+N\/A/);
  assert.match(out, /L1\s+N\/A/);
  assert.match(out, /last received\s+N\/A/);
});

test("DB unavailable: DB ERROR, the monitor still renders", async () => {
  const { dir } = tmpDb();
  const out = await text(src(join(dir, "missing.sqlite3"), dir, { sd: SD_DOWN, health: null }));
  assert.match(out, /DB\s+ERROR/);
  assert.ok(out.includes("SERVICE DOWN") && out.includes("KEYS"));
  assert.match(out, /safe mode\s+N\/A/);
});

test("colour only when asked: plain text has no escape codes and the same content", async () => {
  const f = fixture();
  const s = src(f.path, f.dir);
  const plain = await text(s, false);
  const color = await text(s, true);
  assert.ok(!plain.includes("\x1b"));
  assert.ok(color.includes("\x1b[1;36m"), "PAPER in cyan");
  assert.equal(stripAnsi(color), plain);
});

test("read only: no byte and no file changes, even on a cleanly stopped database", async () => {
  const f = fixture();
  f.db.close();                                                    // clean close: -wal / -shm are removed
  const snap = () => readdirSync(f.dir).filter((x) => x.startsWith("cc.sqlite3")).map((x) => `${x}:${createHash("sha256").update(readFileSync(join(f.dir, x))).digest("hex")}`).sort();
  const before = snap();
  assert.deepEqual(before.map((x) => x.split(":")[0]), ["cc.sqlite3"]);
  const out = await text(src(f.path, f.dir, { sd: SD_DOWN, health: null }));
  assert.ok(out.includes("225.20"), "data read from the in-memory copy");
  assert.deepEqual(snap(), before);
});

test("monitor source: no SQL write, no migration, no non-GET request", () => {
  const code = readFileSync(join(process.cwd(), "src/close-call/monitor.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/.test(code), "no SQL write");
  assert.ok(!/openCloseCallDb|setMeta|healthEvent|writeFileSync|appendFileSync|method:/.test(code));
  assert.match(code, /readonly: true/);
  assert.match(code, /query_only = ON/);
});

// ---------------------------------------------------------------- LIVE views (throwaway keys in a temp live dir)

import { chmodSync as _chmod, cpSync as _cp, mkdirSync as _mkdir, mkdtempSync as _mkdtemp, writeFileSync as _write } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { ensureCanary, recordBackup, recordVerification } from "./backup-gate.js";
import { generateKeys, verifyRestoredKeyDir } from "./live/keygen.js";
import { disarm } from "./safety.js";
import { setMeta } from "./store.js";
import { REFEREE_PACKAGE_SHA256 } from "./fold.js";
import { REFEREE_DID } from "./protocol.js";

const AGE = "age1" + "q".repeat(58);
const LROOM = "d-cc-mon";

/** A prepared LIVE data dir: CC-ADMIN, CC-TEST-001/002, CC001..CC100, verified backup, room READY, journal rows. */
function liveDir(o: { strategy?: number } = {}) {
  const dir = _mkdtemp(join(_tmp(), "closecall-mon-live-"));
  _chmod(dir, 0o700);
  const keys = join(dir, "keys");
  const backups = join(dir, "backups");
  _mkdir(keys, { mode: 0o700 });
  _mkdir(backups, { mode: 0o700 });
  const db = openCloseCallDb(join(dir, "live.sqlite3"));
  _chmod(join(dir, "live.sqlite3"), 0o600);
  let k = 0;
  const cycle = () => {
    ensureCanary(keys);
    const stamp = `20260926T1200${String(k++).padStart(2, "0")}Z`;
    const a = join(backups, `secrets-${stamp}.tar.age`);
    _write(a, stamp);
    recordBackup(keys, a, AGE, Date.now() + 1);
    const c = join(dir, `r-${stamp}`);
    _cp(keys, c, { recursive: true });
    _chmod(c, 0o700);
    recordVerification(db, backups, `secrets-${stamp}.tar.age`, verifyRestoredKeyDir(c).code!);
  };
  cycle();
  const g = { keysDir: keys, backupDir: backups, recipient: AGE };
  generateKeys(db, { ...g, total: 1, role: "admin" }); cycle();
  generateKeys(db, { ...g, total: 2, role: "staging" }); cycle();
  generateKeys(db, { ...g, total: o.strategy ?? 100, role: "strategy" }); cycle();
  db.prepare("UPDATE keys SET status = 'READY', registered = 1, minted = 1").run();
  const admin = db.prepare("SELECT did FROM keys WHERE role = 'admin'").get() as { did: string };
  db.prepare("INSERT INTO rooms_state (name, status, owner_did, evidence, updated_at) VALUES (?, 'READY', ?, '[]', ?)").run(LROOM, admin.did, now());
  setMeta(db, "room_allow_seen", JSON.stringify((db.prepare("SELECT did FROM keys WHERE role <> 'admin'").all() as { did: string }[]).map((r) => r.did)));
  setMeta(db, "room_health", JSON.stringify({ ok: true, at: new Date(T).toISOString(), last_seq: 120 }));
  setMeta(db, `room_generation:${LROOM}`, "1");
  setMeta(db, "bootstrap_done_at", new Date(T).toISOString());
  setMeta(db, "test_trade_settled", "301");
  setMeta(db, "last_db_backup_at", new Date().toISOString());
  db.prepare("INSERT INTO seed (id, price, tid, time, package, json) VALUES (1, '226.14', '1', 't', ?, '{}')").run(REFEREE_PACKAGE_SHA256);
  db.prepare("INSERT INTO raw_posts (room, seq, generation, ts, from_did, text, fetched_at) VALUES ('d-close1-price', 1, 1, 't', ?, ?, ?)")
    .run(REFEREE_DID, JSON.stringify({ t: "seed", season: "close-1", package: REFEREE_PACKAGE_SHA256 }), now());
  setMeta(db, "last_readiness", JSON.stringify({ at: new Date(T - 60_000).toISOString(), pass: true, rows: [
    { name: "nonce reconciliation", ok: true, value: "103 keys checked" }, { name: "room on server", ok: true, value: "owner CC-ADMIN" },
    { name: "clock skew", ok: true, value: "skew 120 ms" }, { name: "referee", ok: true, value: "ok" }, { name: "Hyperliquid feed", ok: true, value: "ok" }] }));
  db.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, pair_index, maker_id, taker_id, terms, payload_sha256, state, post_at, created_at, updated_at)
    VALUES ('i1', 'aaaabbbbccccdddd', 140, 0, 'CC001', 'CC002', '{}', 'x', 'SETTLED', ?, ?, ?)`).run(new Date(T - 30_000).toISOString(), now(), now());
  db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', ?, '5000', ?)").run(`room:${LROOM}`, now());
  const env = { CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_DATA_DIR: dir, CLOSECALL_DB_PATH: join(dir, "live.sqlite3"),
    CLOSECALL_LIVE_DB_PATH: join(dir, "live.sqlite3"), CLOSECALL_LOCK_PATH: join(dir, "live.lock"), CLOSECALL_ROOM: LROOM, CLOSECALL_BACKUP_AGE_RECIPIENT: AGE,
    CLOSECALL_LIVE_WRITER: "armed" };
  return { dir, db, env };
}
const liveSrc = (x: ReturnType<typeof liveDir>, env: Record<string, string> = {}, ntp: boolean | null = true): MonitorSources => ({
  cfg: testConfig({ ...x.env, ...env }), contest: C, now: T, systemd: () => SD_UP, fetchHealth: async () => healthDoc("live"), version: () => "v0.1.0 test", ntp: () => ntp,
});

test("LIVE ready: LIVE title, WRITES ENABLED, readiness PASS, classes, backup, room, nonces, journal -- the paper state never appears", async () => {
  const x = liveDir();
  const out = await text(liveSrc(x));
  for (const s of ["CLOSE CALL — LIVE", "WRITES: ENABLED", "LIVE READINESS: PASS", "KEY CLASSES (REAL KEYS)", "CC-ADMIN", "CC-TEST-001 CC-TEST-002",
    "CC001..CC100", "(no staging/admin)", "live strategy state", "backup age", "restore verify", "generation", "0 mismatches",
    "LIVE JOURNAL", "SETTLED", "CONNECTED · ARMED", "PROTOCOL", "better-sqlite3"]) assert.ok(out.includes(s), `missing ${s}\n${out}`);
  assert.match(out, /STRATEGY\s+100/);
  assert.match(out, /strategy pairs\s+50/);
  assert.match(out, /READY\s+103/);
  assert.ok(!out.includes("FAKE KEYS") && !out.includes("paper strategy state"));
});

test("LIVE candidate: writer disarmed (config or kill switch) -> LIVE CANDIDATE, WRITES DISABLED, readiness FAIL", async () => {
  const x = liveDir({ strategy: 4 });
  const a = await text(liveSrc(x, { CLOSECALL_LIVE_WRITER: "disarmed" }));
  for (const s of ["CLOSE CALL — LIVE CANDIDATE", "WRITES: DISABLED", "LIVE READINESS: FAIL", "CONNECTED · DISARMED"]) assert.ok(a.includes(s), `missing ${s}`);
  disarm(x.dir, "operator");
  assert.match(await text(liveSrc(x)), /kill switch/);
});

test("LIVE failures are visible: backup, room missing, nonce mismatch, UNKNOWN trade, NTP", async () => {
  const x = liveDir({ strategy: 4 });
  _write(join(x.dir, "keys", "CC005.json"), "{}", { mode: 0o600 });                                // key newer than the backup
  x.db.prepare("UPDATE meta SET value = ? WHERE key = 'room_health'").run(JSON.stringify({ ok: false, why: "room-owners gone", at: new Date(T).toISOString() }));
  x.db.prepare("UPDATE meta SET value = ? WHERE key = 'last_readiness'").run(JSON.stringify({ at: new Date(T).toISOString(), pass: false, rows: [{ name: "nonce reconciliation", ok: false, value: "server ahead for CC001" }] }));
  x.db.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, maker_id, taker_id, terms, payload_sha256, state, created_at, updated_at)
    VALUES ('i2', 'eeee', 141, 'CC003', 'CC004', '{}', 'x', 'UNKNOWN', ?, ?)`).run(now(), now());
  const out = await text(liveSrc(x, {}, false));
  assert.match(out, /keys newer\s+YES/);
  assert.match(out, /room missing\s+YES/);
  assert.match(out, /server\/local\s+server ahead/);
  assert.match(out, /unknown\s+1/);
  assert.match(out, /NTP\s+NO \(live FAIL\)/);
  assert.match(out, /LIVE READINESS: FAIL/);
});

test("reconciliation: historical mismatches are not shown as current problems", async () => {
  const f = fixture();
  f.db.prepare("INSERT INTO reconcile (n, level, status, detail, at) VALUES (100, 'L1-referee', 'MISMATCH', '{}', ?)").run(new Date(T - 7_200_000 * 2).toISOString());
  const out = await text(src(f.path, f.dir));
  assert.match(out, /mismatches \(run\)\s+0/);
  assert.match(out, /mismatches \(all\)\s+1/);
});

test("PAPER stays simple: FAKE KEYS, SIMULATED TRADES, WRITES DISABLED, no live blocks", async () => {
  const f = fixture();
  const out = await text(src(f.path, f.dir));
  for (const s of ["FAKE KEYS", "SIMULATED TRADES", "WRITES: DISABLED", "paper strategy state", "NONE (paper)"]) assert.ok(out.includes(s), s);
  for (const s of ["LIVE JOURNAL", "KEY CLASSES", "LIVE READINESS"]) assert.ok(!out.includes(s), `paper must not show ${s}`);
});
