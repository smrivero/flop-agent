/**
 * 29 Sep incident: technocore timeouts; the room-keeper's TimeoutError reached the stage guard, whose
 * `err.code?.startsWith(...)` threw (a DOMException's code is the NUMBER 23), ending the service at sweep 961.
 * Here: the guard with real timeout/abort errors, the whole service loop through a technocore outage and its
 * recovery, the catch-up 961 -> 1158 through the REAL LiveExecutor (no historical intent, no write), and the
 * disarmed start rules.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sweepTime } from "./contest.js";
import { OfficialFold } from "./fold.js";
import { WriteJournal } from "./journal.js";
import { keyId } from "./keys.js";
import { LiveExecutor } from "./live/executor.js";
import { setQuiet } from "./logger.js";
import { foldConfig, PaperTrader, type TradeExecutor } from "./paper.js";
import type { PricePost } from "./protocol.js";
import { REFEREE_DID } from "./protocol.js";
import type { Signer } from "./protocol-writes.js";
import { runStartBlockers, type ReadinessRow } from "./readiness.js";
import { errorCode, errorText, makeGuard, runLoop } from "./run.js";
import { activeHalts, halt } from "./safety.js";
import type { KState } from "./strategy/k-ladder.js";
import { loadStrategyState, now, type CcDb } from "./store.js";
import { contest, RefereeFeed, testConfig, tmpDb, VENDOR } from "./test-helpers.js";
import { ephemeralSigner } from "./testing/ephemeral-signer.js";
import { MockTechnocore } from "./testing/mock-technocore.js";

setQuiet(true);
const C = contest();
const folds: OfficialFold[] = [];
after(() => folds.forEach((f) => f.stop()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The exact object fetch() rejects with when AbortSignal.timeout() fires: a DOMException "TimeoutError", code 23. */
async function realTimeout(): Promise<unknown> {
  const s = AbortSignal.timeout(1);
  await sleep(10);
  return s.reason;
}

// ------------------------------------------------------------------ 1. the error handler
test("the stage guard survives a REAL TimeoutError (DOMException, numeric code 23), AbortError, odd throwables; only SQLITE_* halts", async () => {
  const timeout = await realTimeout();
  assert.equal((timeout as DOMException).name, "TimeoutError");
  assert.equal((timeout as { code: unknown }).code, 23, "a number: `.code?.startsWith` would throw on it");
  const abort = new DOMException("This operation was aborted", "AbortError");
  const { db } = tmpDb();
  const seen: string[] = [];
  const guard = makeGuard(db, (stage, text) => seen.push(`${stage}: ${text}`));
  const throwables: unknown[] = [timeout, abort, Object.assign(new Error("num"), { code: 7 }), { code: { x: 1 } }, "plain string", null, undefined, 42,
    Object.assign(new Error("busy"), { code: "SQLITE_BUSY" })];
  for (const [i, t] of throwables.entries()) {
    assert.equal(await guard(`s${i}`, () => { throw t; }), undefined, `throwable ${i} is contained`);
  }
  assert.equal(seen.length, throwables.length);
  assert.match(seen[0], /timeout/);
  assert.equal(Object.keys(activeHalts(db)).length, 0, "no halt for network errors, odd codes, or SQLITE_BUSY");
  await guard("db", () => { throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }); });
  assert.ok(activeHalts(db).db_corruption, "a real SQLite corruption still halts");
  assert.equal(errorCode(timeout), null);
  assert.equal(errorCode({ code: "SQLITE_FULL" }), "SQLITE_FULL");
  assert.equal(errorText(null), "null");
  assert.equal(errorText(timeout), (timeout as DOMException).message);
});

// ------------------------------------------------------------------ 2. the whole service loop through an outage
function refereeRooms(from: number, to: number) {
  const rooms = new Map<string, { seq: number; ts: string; from: string; text: string }[]>();
  const push = (room: string, body: Record<string, unknown>) => {
    const list = rooms.get(room) ?? [];
    list.push({ seq: list.length + 1, ts: new Date().toISOString(), from: REFEREE_DID, text: JSON.stringify(body) });
    rooms.set(room, list);
  };
  push("d-close1-price", { t: "seed", season: "close-1", price: "226.14", trade: { tid: 1, time: "2026-09-25T11:59:42Z" },
    package: "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa", rooms: [], limits: ["214.84", "237.44"], for: 1 });
  for (let n = from; n <= to; n++) {
    const close = (226 + (n % 7) * 0.1).toFixed(2), prev = (226 + ((n - 1) % 7) * 0.1).toFixed(2);
    const lo = (Math.ceil(Number(close) * 95 - 1e-9) / 100).toFixed(2), hi = (Math.floor(Number(close) * 105 + 1e-9) / 100).toFixed(2);
    push("d-close1-price", { t: "price", n, ref: { px: close, tid: 1000 + n, time: "2026-09-29T00:00:00Z" }, limits: [lo, hi], global: "226.14", file: `f${n}`, applied: prev, for: n + 1, age_s: 3 });
    push("d-close1-flow", { t: "flow", n, mints: [], rooms: [], settled: [], void: [], missed: [], file: `f${n}`, omitted: { mints: 0 } });
    push("d-close1-positions", { t: "positions", n, open: "0", longs: 0, shorts: 0, top: [], file: `f${n}` });
    push("d-close1-pnl", { t: "pnl", n, mark: "226.14", top: [], file: `f${n}` });
    push("d-close1-state", { t: "state", n, root: "r", owners: 0, rooms: 1, file: `f${n}` });
  }
  return rooms;
}

test("service loop: price + flow timeouts, room-keeper timing out on EVERY tick, an outage, then recovery -> alive, reconnects, caught up, nothing written", async () => {
  const { db, dir } = tmpDb();
  const rooms = refereeRooms(962, 1158);
  const timeout = await realTimeout();
  let refereeCalls = 0, hlCalls = 0, keeperCalls = 0;
  const OUTAGE = 3;                                                    // 3 polls in a row time out (backoff 2 s, 4 s, 8 s), then technocore is back
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("hyperliquid")) { hlCalls++; throw timeout; }       // Hyperliquid down during the whole test as well
    if (init?.method && init.method !== "GET") throw new Error(`the loop must never write: ${init.method} ${u}`);
    refereeCalls++;
    if (refereeCalls <= OUTAGE) throw timeout;
    const m = u.match(/\/r\/([^?]+)\?format=json&since=(\d+)&limit=(\d+)/)!;
    const list = rooms.get(m[1]) ?? [];
    const msgs = list.filter((x) => x.seq > Number(m[2])).slice(0, Number(m[3]));
    return new Response(JSON.stringify({ room: m[1], first_seq: list[0]?.seq ?? null, last_seq: list.at(-1)?.seq ?? 0, generation: 1, messages: msgs }), { status: 200 });
  }) as typeof fetch;
  const cfg = testConfig({ CLOSECALL_DATA_DIR: dir, CLOSECALL_DB_PATH: `${dir}/cc.sqlite3`, CLOSECALL_HEALTH_ENABLED: "false", CLOSECALL_REFEREE_POLL_MS: "2000" });
  await runLoop(db, cfg, C, { paper: false, fetchImpl, maxMinutes: 0.45, maintenance: async () => { keeperCalls++; throw timeout; } });
  // runLoop returned on its own time limit: the process never died
  const last = (db.prepare("SELECT MAX(n) n FROM sweeps WHERE ref_px IS NOT NULL").get() as { n: number }).n;
  assert.equal(last, 1158, "caught up to the head after the outage");
  assert.ok(refereeCalls > OUTAGE, "the observer reconnected after the timeouts");
  assert.ok(keeperCalls >= 1 && hlCalls >= 1, "the failing room-keeper and Hyperliquid did not stop the loop");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM write_attempts").get() as { c: number }).c, 0, "no write");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM intents").get() as { c: number }).c, 0, "no intent");
  assert.ok(!activeHalts(db).db_corruption, "no false db_corruption halt from a TimeoutError");
  const stops = db.prepare("SELECT COUNT(*) c FROM health_events WHERE kind = 'stop'").get() as { c: number };
  assert.equal(stops.c, 1, "one clean stop at the time limit, no crash");
});

// ------------------------------------------------------------------ 3. catch-up 961 -> 1158 through the real LiveExecutor
const ROOM = "d-cc-recovery-test";
interface World { db: CcDb; feed: RefereeFeed; srv: MockTechnocore; signers: Map<string, Signer>; clock: { t: number } }
const at = (n: number) => sweepTime(C, n) - 20_000;
const priceOf = (events: { kind: string; post?: unknown }[]) => events.find((e) => e.kind === "price")!.post as PricePost;

function liveWorld(nKeys: number): World {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed("226.14");
  const signers = new Map<string, Signer>();
  for (let i = 1; i <= nKeys; i++) {
    const s = ephemeralSigner();
    signers.set(keyId(i), s);
    db.prepare(`INSERT INTO keys (id, did, key_path, fake, registered, minted, minted_sweep, mint_evidence, status, updated_at)
      VALUES (?, ?, '/k', 0, 1, 1, 1, '{"source":"protocol","sweep":1}', 'READY', ?)`).run(keyId(i), s.did, now());
  }
  db.prepare("INSERT INTO rooms_state (name, status, owner_did, evidence, updated_at) VALUES (?, 'READY', ?, '[]', ?)").run(ROOM, signers.get("CC001")!.did, now());
  const srv = new MockTechnocore();
  srv.notes.set(`room-owners/${ROOM}`, signers.get("CC001")!.did);
  srv.notes.set(`room-allow/${ROOM}`, [...signers.values()].slice(1).map((s) => s.did).join(" "));
  const clock = { t: at(960) };
  srv.clock = () => clock.t;
  return { db, feed, srv, signers, clock };
}

test("catch-up: live DB at sweep 961, referee at 1158 -> caught up with 0 new intents, 0 writes, pairs and lo/hi unchanged; disarmed stays silent; armed resumes at 1159 normally", async () => {
  const w = liveWorld(8);
  const exec = new LiveExecutor(w.db, w.signers, new WriteJournal(w.db, w.signers, w.srv, { clock: () => w.clock.t }), w.srv, ROOM, C, 3_000, () => w.clock.t);
  const main = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  const look = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  folds.push(main, look);
  const p = new PaperTrader(w.db, testConfig({ CLOSECALL_KEY_COUNT: "8", CLOSECALL_ROOM: ROOM }), C, main, look, null, exec as TradeExecutor);
  p.clock = () => w.clock.t;
  await p.start();
  await p.settle(960, priceOf(w.feed.sweep(960, { close: "226.00", applied: "226.00", owners: 8, prevOwners: 0 })));
  w.clock.t = at(961) + 500;
  const first = await p.decide(961, true, at(961));
  assert.equal(first.length, 2, "K's split start at 961 (the state before the outage)");
  await p.settle(961, priceOf(w.feed.sweep(961, { close: "226.00", applied: "226.00", owners: 8, prevOwners: 8 })));
  const before = { intents: (w.db.prepare("SELECT COUNT(*) c FROM intents").get() as { c: number }).c, posts: w.srv.posts, k: JSON.stringify(loadStrategyState<KState>(w.db, "K")) };

  // OUTAGE -> recovery: the referee kept publishing 962..1158 while we were down; NVDA ran far past both triggers.
  w.clock.t = at(1159) + 500;
  let prev = "226.00";
  for (let n = 962; n <= 1158; n++) {
    const close = (226 + (n - 961) * 0.05).toFixed(2);                  // up to ~235.85, far beyond hi*(1+0.25%)
    await p.settle(n, priceOf(w.feed.sweep(n, { close, applied: prev, owners: 8, prevOwners: 8 })));   // what the loop does per price event
    prev = close;
  }
  await p.retryDeferred();
  const lastRx = (w.db.prepare("SELECT MAX(n) n FROM sweeps WHERE ref_px IS NOT NULL").get() as { n: number }).n;
  assert.equal(lastRx, 1158, "last received = the head");
  assert.equal((w.db.prepare("SELECT COUNT(*) c FROM intents").get() as { c: number }).c, before.intents, "0 historical intents");
  assert.equal(w.srv.posts, before.posts, "0 writes");
  assert.equal(JSON.stringify(loadStrategyState<KState>(w.db, "K")), before.k, "pairs_used, lo and hi unchanged: nothing replayed historically");
  assert.equal(Object.keys(activeHalts(w.db)).length, 0);
  assert.equal((w.db.prepare("SELECT COUNT(*) c FROM live_trades WHERE state NOT IN ('SETTLED','VOID','NOT_APPLIED','NOT_POSTED')").get() as { c: number }).c, 0, "pending 0, unknown 0");
  const l2 = w.db.prepare("SELECT COUNT(*) c FROM reconcile WHERE level LIKE 'L2%' AND status <> 'OK'").get() as { c: number };
  assert.equal(l2.c, 0, "L2 official fold == mirror after the catch-up");

  // Still DISARMED at the first live decision: estimate only, K untouched.
  p.canTrade = () => "kill switch: recovery";
  assert.deepEqual(await p.decide(1159, true, at(1159)), []);
  assert.equal(JSON.stringify(loadStrategyState<KState>(w.db, "K")), before.k, "disarmed: no pair consumed");
  assert.equal(w.srv.posts, before.posts);

  // Armed by the operator: the next sweep trades normally, ONE trigger at the live price (not 197 historical ones).
  p.canTrade = () => null;
  w.clock.t = at(1160) + 500;
  w.feed.sweep(1159, { close: prev, applied: prev, owners: 8, prevOwners: 8 });
  const next = await p.decide(1160, true, at(1160));
  assert.equal(next.length, 1, "one new-high pair at the live price");
  assert.equal(next[0].intent.trigger, "new-high");
  assert.equal(w.srv.posts, before.posts + 1, "posted once");
  const k = loadStrategyState<KState>(w.db, "K")!;
  assert.equal(k.nextPair, JSON.parse(before.k).nextPair + 1);
  assert.equal(k.hi, Number(prev), "hi = the live price that triggered, lo unchanged");
  assert.equal(k.lo, JSON.parse(before.k).lo);
});

// ------------------------------------------------------------------ 4. starting disarmed
test("live run start: a DISARMED writer starts in catch-up mode; a transient halt from the outage does not block it; a grave halt does", () => {
  const row = (name: string, ok: boolean): ReadinessRow => ({ name, ok, value: "" });
  const rows = [row("writer", false), row("not halted", false), row("referee", true)];
  assert.deepEqual(runStartBlockers(rows, false, true), [], "disarmed + only transient halts (referee_stale): start and catch up");
  assert.deepEqual(runStartBlockers(rows, false, false).map((r) => r.name), ["not halted"], "a grave halt blocks");
  assert.deepEqual(runStartBlockers(rows, true, true).map((r) => r.name), ["not halted"], "armed: every halt blocks, as before");
  assert.deepEqual(runStartBlockers([row("writer", false), row("referee", false)], false, true).map((r) => r.name), ["referee"], "a failing network row still blocks");
  const { db } = tmpDb();
  halt(db, "referee_stale", "no new referee message for 4000 s");
  assert.equal(activeHalts(db).referee_stale.severity, "transient");
});
