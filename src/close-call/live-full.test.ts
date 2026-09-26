/**
 * FULL operational simulation, offline, before any real key exists:
 *   empty state -> CC-ADMIN + staging bootstrap -> staging 0.10 trade -> 100 strategy keys -> Strategy K live
 * on the in-memory technocore (signatures, nonces, owned-room gate, faults) with the simulated referee and the
 * OFFICIAL fold, through the real Bootstrap, WriteJournal, LiveExecutor, RoomKeeper and decision engine.
 *
 * Faults: restarts mid-bootstrap (every step) and mid-trading, lost requests, timeouts after commit, 429s,
 * the referee missing our messages (bootstrap AND a trade), truncated settled lists, a stale referee, a
 * Hyperliquid halt, and finally our room disappearing.
 * Invariants: 0 duplicate writes, 0 duplicate trade ids, 0 unresolved journal rows, 0 fold/referee
 * disagreements, 0 lost strategy pairs, staging/admin never used by the strategy, strategy keys flat until used.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { RoomKeeper } from "./bootstrap.js";
import { sweepTime } from "./contest.js";
import { OfficialFold } from "./fold.js";
import { WriteJournal } from "./journal.js";
import { keysByRole } from "./keys.js";
import { LiveExecutor } from "./live/executor.js";
import { foldConfig, PaperTrader } from "./paper.js";
import type { PricePost } from "./protocol.js";
import { activeHalts, clearTransient, halt } from "./safety.js";
import { contest, testConfig, VENDOR } from "./test-helpers.js";
import { simulateBootstrap } from "./testing/bootstrap-sim.js";

const C = contest();
const folds: OfficialFold[] = [];
after(() => folds.forEach((f) => f.stop()));

test("FULL: empty -> admin/staging -> 100 strategy keys -> Strategy K live, with every fault; all invariants hold", async () => {
  const boot = await simulateBootstrap(C, { stages: [0, 100], startSweep: 300, faults: true, missFirstOwner: true, rate429At: [4, 20, 60] });
  assert.ok(boot.ok, JSON.stringify(boot.checks.filter((c) => !c.ok)));
  const w = boot.world;
  assert.equal(keysByRole(w.db, "strategy").length, 100);

  let p!: PaperTrader;
  let exec!: LiveExecutor;
  let keeper!: RoomKeeper;
  const start = async () => {                                                  // (re)start the live service
    const journal = new WriteJournal(w.db, w.signers, w.srv, { clock: w.now });
    exec = new LiveExecutor(w.db, w.signers, journal, w.srv, w.room, C, 3_000, w.now, async (ms) => w.setNow(w.now() + ms));
    const main = await OfficialFold.start("python3", VENDOR, foldConfig(C));
    const look = await OfficialFold.start("python3", VENDOR, foldConfig(C));
    folds.push(main, look);
    p = new PaperTrader(w.db, testConfig({ CLOSECALL_KEY_COUNT: "100", CLOSECALL_ROOM: w.room }), C, main, look, null, exec);
    p.clock = w.now;
    await p.start();
    keeper = new RoomKeeper({ db: w.db, journal, transport: w.srv, room: w.room, clock: w.now });
  };
  await start();
  assert.equal(p.keys.length, 100, "strategy keys only (admin + staging excluded)");
  assert.ok(p.keys.every((k) => k.role === "strategy"));
  assert.equal((await keeper.tick()).ok, true);

  const priceOf = (n: number) => JSON.parse((w.db.prepare("SELECT price_json FROM sweeps WHERE n = ?").get(n) as { price_json: string }).price_json) as PricePost;
  const first = w.published() + 1;
  // Close path: flat, then a 0.3% step down every sweep (a new low each time at a 0.25% threshold).
  let px = 226.0;
  const lag = 20_000;
  for (let i = 0; i < 10; i++) {
    const n = first + i;
    // faults before the decision
    if (i === 1) w.srv.failNext("429");
    if (i === 2) w.srv.failNext("timeout-after-commit");
    if (i === 3) await start();                                               // crash + restart mid-trading
    if (i === 4) halt(w.db, "hyperliquid_stale", "feed down (simulated)");
    w.setNow(sweepTime(C, n) - 20_000 + 500);
    const sent = await p.decide(n, true, w.now());
    if (i === 4) { assert.equal(sent.length, 0, "HL halt: no entries"); clearTransient(w.db, "hyperliquid_stale"); }
    if (i === 5) assert.equal(sent.length, 0, "stale referee: HALT_NEW_ENTRIES");
    // referee side of the sweep
    w.referee.opts.ref = px.toFixed(2);
    w.referee.opts.ageS = i === 4 ? 400 : undefined;                          // the reference sweep 5 will trade against is stale
    w.referee.opts.listSettled = i < 6;                                       // from here on the settled list is truncated
    if (i === 7) {                                                           // the referee "misses" this sweep's trades in our room
      const seqs = (w.db.prepare("SELECT seq FROM live_trades WHERE sweep = ? AND seq IS NOT NULL").all(n) as { seq: number }[]).map((r) => r.seq);
      await exec.confirmPosted();
      const all = (w.db.prepare("SELECT seq FROM live_trades WHERE sweep = ?").all(n) as { seq: number }[]).map((r) => r.seq).filter(Boolean);
      const lo = Math.min(...all, ...seqs), hi = Math.max(...all, ...seqs);
      if (all.length) w.referee.opts.missSeqs = [{ room: w.room, from: lo, to: hi }];
    }
    w.setNow(sweepTime(C, n) + lag + 1);
    w.publish(n);
    w.referee.opts.missSeqs = undefined;
    await p.settle(n, priceOf(n));
    await p.retryDeferred();
    p.verifyWithReferee();
    await keeper.tick();
    if (i >= 1) px = +(px * 0.997).toFixed(2);
  }

  // ---- invariants
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = w.db.prepare("SELECT * FROM live_trades ORDER BY created_at").all() as any[];
  assert.ok(rows.length >= 8, `trades executed: ${rows.length}`);
  process.stdout.write(`# FULL SIM: ${rows.length} live trades: ${JSON.stringify(Object.fromEntries([...new Set(rows.map((r) => r.state))].map((s) => [s, rows.filter((r) => r.state === s).length])))}; referee ${JSON.stringify(Object.fromEntries([...new Set(rows.map((r) => r.referee_outcome))].map((s) => [s, rows.filter((r) => r.referee_outcome === s).length])))}; server posts ${w.srv.posts}\n`);
  const messages = [...w.srv.rooms.values()].flat();
  const reposts = (w.db.prepare("SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) s FROM meta WHERE key LIKE 'owner_reposts:%'").get() as { s: number }).s;
  assert.equal(new Set(messages.map((m) => `${m.from}|${m.text}`)).size, messages.length - reposts, "0 duplicate writes");
  const tradeMsgs = messages.filter((m) => m.text.startsWith('{"t":"trade"')).map((m) => (JSON.parse(m.text) as { terms: { id: string } }).terms.id);
  assert.equal(new Set(tradeMsgs).size, tradeMsgs.length, "0 duplicate trade ids on the server");
  assert.equal(new Set(rows.map((r) => r.trade_id)).size, rows.length, "0 duplicate trade ids in the journal");
  const unresolved = rows.filter((r) => ["CREATED", "SIGNED", "POSTING", "POSTED", "UNKNOWN"].includes(r.state));
  assert.deepEqual(unresolved.map((r) => `${r.trade_id}:${r.state}`), [], "0 unresolved live trades");
  assert.equal((w.db.prepare("SELECT COUNT(*) n FROM reconcile WHERE level LIKE 'L3%' AND status <> 'OK'").get() as { n: number }).n, 0, "fold and referee never disagreed");
  assert.ok(rows.some((r) => r.state === "NOT_APPLIED"), "the missed trade was kept out of the book");
  assert.ok(rows.some((r) => r.referee_outcome === "unlisted"), "truncated lists -> unlisted, no halt");
  assert.ok(rows.some((r) => r.referee_outcome === "settled"), "listed settlements verified");
  const staging = new Set([...keysByRole(w.db, "staging"), ...keysByRole(w.db, "admin")].map((k) => k.id));
  assert.ok(rows.every((r) => !staging.has(r.maker_id) && !staging.has(r.taker_id)), "admin/staging never used by the strategy");
  // 0 lost pairs: every pair whose trade did not settle is queued for a retry or settled later
  const settledPairs = new Set(rows.filter((r) => r.state === "SETTLED").map((r) => r.pair_index));
  const retryPairs = new Set(p.state.retries.map((r) => r.pairIndex));
  const lost = rows.filter((r) => r.state !== "SETTLED" && !settledPairs.has(r.pair_index) && !retryPairs.has(r.pair_index));
  assert.deepEqual(lost.map((r) => `${r.pair_index}:${r.state}`), [], "0 lost strategy pairs");
  // untouched strategy keys are still flat with 10,000 POLF in our book
  const usedKeys = new Set(rows.flatMap((r) => [r.maker_id, r.taker_id]));
  const idle = p.keys.filter((k) => !usedKeys.has(k.id));
  assert.ok(idle.length > 0);
  for (const k of idle) {
    const a = p.ledger.accounts.get(k.did)!;
    assert.equal(a.cash, 10_000_000_000n, `${k.id} cash`);
    assert.equal(a.position, 0n, `${k.id} flat`);
  }
  assert.equal(Object.keys(activeHalts(w.db)).length, 0, "no halt left over from the transient faults");

  // ---- our room disappears: detected, grave halt, never re-created, no new entries
  w.srv.notes.delete(`room-owners/${w.room}`);
  const posts = w.srv.posts;
  const t = await keeper.tick();
  assert.equal(t.ok, false);
  assert.ok(activeHalts(w.db).room_ownership, "room_ownership halt");
  assert.equal(w.srv.posts, posts, "nothing re-claimed or recreated");
  const n = first + 10;
  w.setNow(sweepTime(C, n) - 19_500);
  assert.deepEqual(await p.decide(n, true, w.now()), [], "no new entries while the room is missing");
  const alert = w.db.prepare("SELECT message FROM alerts WHERE message LIKE 'HALTED: room_ownership%'").get() as { message: string } | undefined;
  assert.ok(alert, "the grave halt is in the alerts table");
});
