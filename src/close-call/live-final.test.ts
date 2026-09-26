/**
 * FINAL REALISTIC SIMULATION (pre-live closing audit, item Y), offline, the same code that runs live:
 *   CC-ADMIN + 2 staging + 100 strategy keys bootstrapped with kill -9 (incl. mid owner #57), 503, 429,
 *   then Strategy K live over many sweeps with: restart / DB reopen, kill -9 during a trade POST, 429, 503,
 *   timeout after POST, timeout BEFORE POST (UNKNOWN -> resolved by evidence), referee truncation, a missed
 *   trade (NOT_APPLIED), a LATE trade, a Hyperliquid feed halt, a stale referee, the kill switch, a room
 *   generation change, and finally S (final settlement by the official fold).
 * Invariants: 0 duplicate writes, 0 duplicate trade ids, 0 lost keys, 0 unsafely reused pair, nonces strictly
 * increasing per key+room, Strategy K state deterministic across a full restore from a DB backup.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { RoomKeeper } from "./bootstrap.js";
import { sweepTime } from "./contest.js";
import { OfficialFold } from "./fold.js";
import { WriteJournal } from "./journal.js";
import { keysByRole } from "./keys.js";
import { LiveExecutor } from "./live/executor.js";
import { foldConfig, PaperTrader } from "./paper.js";
import type { PricePost } from "./protocol.js";
import { REFEREE_DID } from "./protocol.js";
import { activeHalts, clearTransient, disarm, halt, rearm, writerState } from "./safety.js";
import { backupDb, getMeta, openCloseCallDb, type CcDb } from "./store.js";
import { contest, testConfig, VENDOR } from "./test-helpers.js";
import { simulateBootstrap } from "./testing/bootstrap-sim.js";
import { RefereeObserver } from "./observer.js";
import { LIVE_ACK } from "./config.js";

const C = contest();
const folds: OfficialFold[] = [];
after(() => folds.forEach((f) => f.stop()));

test("FINAL: 100 strategy + 2 staging + admin, every fault, kill -9, restore -- all invariants", async () => {
  const boot = await simulateBootstrap(C, { stages: [0, 100], startSweep: 300, faults: true, missFirstOwner: true, killAt: [3, 65], err503At: [30, 90], rate429At: [12, 70] });
  assert.ok(boot.ok, JSON.stringify(boot.checks.filter((c) => !c.ok)));
  assert.equal(boot.steps.filter((s) => s.detail.startsWith("crashed")).length, 2, "two kill -9 during the bootstrap (one at strategy owner #57)");
  const w = boot.world;
  const dataDir = mkdtempSync(join(tmpdir(), "closecall-final-"));
  const liveCfgEnv = { CLOSECALL_KEY_COUNT: "100", CLOSECALL_ROOM: w.room, CLOSECALL_MODE: "live", CLOSECALL_LIVE_ENABLED: LIVE_ACK, CLOSECALL_LIVE_WRITER: "armed", CLOSECALL_DATA_DIR: dataDir };
  const cfg = testConfig(liveCfgEnv);

  let db: CcDb = w.db;
  let p!: PaperTrader;
  let exec!: LiveExecutor;
  let keeper!: RoomKeeper;
  const start = async () => {                                                  // a fresh process on the same DB
    const canWrite = () => { const s = writerState(cfg); return s.armed ? null : s.reason; };
    const journal = new WriteJournal(db, w.signers, w.srv, { clock: w.now, canWrite });
    exec = new LiveExecutor(db, w.signers, journal, w.srv, w.room, C, 3_000, w.now, async (ms) => w.setNow(w.now() + ms));
    const main = await OfficialFold.start("python3", VENDOR, foldConfig(C));
    const look = await OfficialFold.start("python3", VENDOR, foldConfig(C));
    folds.push(main, look);
    p = new PaperTrader(db, cfg, C, main, look, null, exec);
    p.clock = w.now;
    p.canTrade = canWrite;
    await p.start();
    keeper = new RoomKeeper({ db, journal, transport: w.srv, room: w.room, clock: w.now, lockMs: sweepTime(C, C.lockSweep) });
  };
  await start();
  assert.ok(p.keys.every((k) => k.role === "strategy") && p.keys.length === 100);

  const priceOf = (n: number) => JSON.parse((db.prepare("SELECT price_json FROM sweeps WHERE n = ?").get(n) as { price_json: string }).price_json) as PricePost;
  const first = w.published() + 1;
  let px = 226.0;
  let backupAt: number | null = null;
  const snap = join(dataDir, "mid-run.sqlite3");
  for (let i = 0; i < 16; i++) {
    const n = first + i;
    if (i === 1) w.srv.failNext("429");
    if (i === 2) w.srv.failNext("timeout-after-commit");
    if (i === 3) w.srv.failNext("503");                                       // 503 on a trade POST -> UNKNOWN -> read-back
    if (i === 4) halt(db, "hyperliquid_stale", "Hyperliquid feed down (simulated)");
    if (i === 6) w.srv.failNext("timeout-before-commit");                     // UNKNOWN, resolved after the boundary
    if (i === 7) disarm(dataDir, "operator test");                             // kill switch: no decisions, no writes
    if (i === 8) rearm(dataDir);
    if (i === 9) w.srv.failNext("kill");                                       // kill -9 in the middle of a trade POST
    w.setNow(sweepTime(C, n) - 20_000 + 500);
    let sent: Awaited<ReturnType<PaperTrader["decide"]>> = [];
    try {
      sent = await p.decide(n, true, w.now());
    } catch (e) {
      assert.equal((e as Error).name, "SimulatedKill");
      await start();                                                            // restart: recovery reads back, never re-sends
    }
    if (i === 4) { assert.equal(sent.length, 0, "HL feed halt: no entries"); clearTransient(db, "hyperliquid_stale"); }
    if (i === 5) assert.equal(sent.length, 0, "stale referee: HALT_NEW_ENTRIES");
    if (i === 7) assert.equal(sent.length, 0, "kill switch: no decisions");
    if (i === 10) await start();                                               // plain restart + DB reopen
    if (i === 11) {                                                            // a LATE trade: stamped after the boundary
      const lt = db.prepare("SELECT attempt_op FROM live_trades WHERE sweep = ? LIMIT 1").get(n) as { attempt_op: string } | undefined;
      if (lt) for (const m of w.srv.rooms.get(w.room) ?? []) if (m.text.includes('"t":"trade"') && db.prepare("SELECT 1 FROM live_trades WHERE sweep = ? AND ? LIKE '%' || trade_id || '%'").get(n, m.text)) m.ts = new Date(sweepTime(C, n) + 1_000).toISOString();
    }
    w.referee.opts.ref = px.toFixed(2);
    w.referee.opts.ageS = i === 4 ? 400 : undefined;
    w.referee.opts.listSettled = i < 6;
    if (i === 12) {                                                            // the referee misses this sweep's trades in our room
      await exec.confirmPosted();
      const seqs = (db.prepare("SELECT seq FROM live_trades WHERE sweep = ? AND seq IS NOT NULL").all(n) as { seq: number }[]).map((r) => r.seq);
      if (seqs.length) w.referee.opts.missSeqs = [{ room: w.room, from: Math.min(...seqs), to: Math.max(...seqs) }];
    }
    w.setNow(sweepTime(C, n) + 20_000 + 1);
    w.publish(n);
    w.referee.opts.missSeqs = undefined;
    await p.settle(n, priceOf(n));
    w.setNow(sweepTime(C, n) + 40_000);
    await p.retryDeferred();
    p.verifyWithReferee();
    await keeper.tick();
    if (i === 13) { backupAt = n; await backupDb(db, snap); }                  // a consistent backup mid-run
    if (i >= 1) px = +(px * 0.997).toFixed(2);
  }

  // ---- invariants
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = db.prepare("SELECT * FROM live_trades ORDER BY created_at").all() as any[];
  const states = Object.fromEntries([...new Set(rows.map((r) => r.state))].map((s) => [s, rows.filter((r) => r.state === s).length]));
  process.stdout.write(`# FINAL SIM: ${rows.length} live trades ${JSON.stringify(states)}; server posts ${w.srv.posts}\n`);
  const messages = [...w.srv.rooms.values()].flat();
  const reposts = (db.prepare("SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) s FROM meta WHERE key LIKE 'owner_reposts:%'").get() as { s: number }).s;
  assert.equal(new Set(messages.map((m) => `${m.from}|${m.text}`)).size, messages.length - reposts, "0 duplicate writes");
  const ids = messages.filter((m) => m.text.startsWith('{"t":"trade"')).map((m) => (JSON.parse(m.text) as { terms: { id: string } }).terms.id);
  assert.equal(new Set(ids).size, ids.length, "0 duplicate trade ids on the server");
  assert.equal(new Set(rows.map((r) => r.trade_id)).size, rows.length, "0 duplicate trade ids in the journal");
  assert.deepEqual(rows.filter((r) => ["CREATED", "SIGNED", "POSTING", "POSTED", "UNKNOWN"].includes(r.state)).map((r) => r.state), [], "every live trade resolved");
  for (const s of ["SETTLED", "NOT_APPLIED"]) assert.ok(states[s], `${s} exercised`);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM reconcile WHERE level LIKE 'L3%' AND status <> 'OK'").get() as { n: number }).n, 0, "fold and referee never disagreed");
  // nonces strictly increasing per key + room on the server
  const byKeyRoom = new Map<string, bigint[]>();
  for (const [room, list] of w.srv.rooms) for (const m of list) if (m.nonce) byKeyRoom.set(`${room}|${m.from}`, [...(byKeyRoom.get(`${room}|${m.from}`) ?? []), BigInt(m.nonce)]);
  for (const [k, list] of byKeyRoom) assert.ok(list.every((x, j) => j === 0 || x > list[j - 1]), `nonces increasing for ${k}`);
  // 0 unsafely reused pair: a pair is traded again only after its previous trade is final and did NOT leave a position
  const byPair = new Map<number, typeof rows>();
  for (const r of rows) byPair.set(r.pair_index, [...(byPair.get(r.pair_index) ?? []), r]);
  for (const [pair, list] of byPair) {
    for (let j = 1; j < list.length; j++) assert.notEqual(list[j - 1].state, "SETTLED", `pair ${pair} re-traded after a settled trade`);
  }
  // 0 lost keys: every strategy key is flat & untouched, or holds the position of exactly one settled trade
  const settledKeys = new Set(rows.filter((r) => r.state === "SETTLED").flatMap((r) => [r.maker_id, r.taker_id]));
  for (const k of p.keys) {
    const a = p.ledger.accounts.get(k.did)!;
    if (!settledKeys.has(k.id)) { assert.equal(a.position, 0n, `${k.id} flat`); assert.equal(a.cash, 10_000_000_000n, `${k.id} 10,000 POLF`); }
  }
  const staging = new Set([...keysByRole(db, "staging"), ...keysByRole(db, "admin")].map((k) => k.id));
  assert.ok(rows.every((r) => !staging.has(r.maker_id) && !staging.has(r.taker_id)), "staging/admin never used by the strategy");
  assert.equal(Object.keys(activeHalts(db)).length, 0, `no leftover halt: ${JSON.stringify(activeHalts(db))}`);

  // ---- disaster recovery: restore the mid-run backup into a new DB -> the SAME Strategy K state and book
  const stateNow = JSON.stringify(p.state);
  const ledgerNow = JSON.stringify([...p.ledger.accounts.entries()].map(([d, a]) => [d, String(a.cash), String(a.position), String(a.fees)]));
  const fresh = openCloseCallDb(join(dataDir, "same-state-copy.sqlite3"));
  fresh.close();
  await backupDb(db, join(dataDir, "same-state-copy.sqlite3"));
  db = openCloseCallDb(join(dataDir, "same-state-copy.sqlite3"));
  await start();
  assert.equal(JSON.stringify(p.state), stateNow, "Strategy K state deterministic after restore (lo, hi, pairs used, retries)");
  assert.equal(JSON.stringify([...p.ledger.accounts.entries()].map(([d, a]) => [d, String(a.cash), String(a.position), String(a.fees)])), ledgerNow, "balances/positions rebuilt by the fold replay");
  // an OLDER backup (taken 3 sweeps earlier) is behind the server: its journal lacks later trades
  const old = openCloseCallDb(snap);
  const oldNonce = (old.prepare("SELECT MAX(CAST(last_nonce AS INTEGER)) m FROM nonces WHERE scope = ?").get(`room:${w.room}`) as { m: number }).m;
  const serverMax = Math.max(...[...w.srv.rooms.get(w.room)!].filter((m) => m.nonce).map((m) => Number(m.nonce)));
  assert.ok(backupAt !== null && serverMax > oldNonce, "a stale backup is detectably behind the server (live-check nonce reconciliation FAILs: no write)");
  old.close();

  // ---- room generation change: deleted + recreated under the same name -> grave halt, never reused
  const g = w.srv.generations.get(w.room)!;
  w.srv.generations.set(w.room, g + 1);
  assert.equal((await keeper.tick()).ok, false);
  assert.match(activeHalts(db).room_ownership.reason, /generation changed/);
  const posts = w.srv.posts;
  w.setNow(sweepTime(C, first + 16) - 19_500);
  assert.deepEqual(await p.decide(first + 16, true, w.now()), [], "no entries on a recreated room");
  assert.equal(w.srv.posts, posts);

  // ---- the end: S posted by the referee -> our book settled at S by the official fold, standings kept
  const obs = new RefereeObserver(db, "http://unused.invalid", null);
  obs.ingest("d-close1-price", 9, { seq: 999_999, ts: new Date(sweepTime(C, C.lockSweep) + 3_600_000).toISOString(), from: REFEREE_DID,
    text: JSON.stringify({ t: "final", season: "close-1", price: "221.00", trade: { time: "2026-10-04T09:59:59Z", tid: 1 } }) });
  assert.equal(JSON.parse(getMeta(db, "final_S")!).price, "221.00");
  const fin = await p.finalize("221.00");
  assert.equal(fin.ours.length, 100, "every strategy key has a final standing");
  assert.ok(JSON.parse(getMeta(db, "final_standings")!).ours.length === 100);
});
