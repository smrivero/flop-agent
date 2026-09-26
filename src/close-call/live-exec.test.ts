/**
 * LiveExecutor end to end, offline: the SAME decision engine as paper (official fold, Strategy K, risk),
 * real signatures from throwaway in-memory keys, the in-memory technocore enforcing signatures, nonces,
 * the owned-room gate and faults. Nothing here talks to technocore.chat.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { verifyEd25519 } from "../identity.js";
import { sweepTime } from "./contest.js";
import { OfficialFold } from "./fold.js";
import { WriteJournal } from "./journal.js";
import { keyId } from "./keys.js";
import { LiveExecutor } from "./live/executor.js";
import { foldConfig, PaperTrader, type ExecIntent, type TradeExecutor } from "./paper.js";
import { makerSigningString, takerSigningString, type PricePost, type Terms } from "./protocol.js";
import type { Signer } from "./protocol-writes.js";
import { activeHalts, halt } from "./safety.js";
import { now, type CcDb } from "./store.js";
import { contest, RefereeFeed, testConfig, tmpDb, VENDOR } from "./test-helpers.js";
import { ephemeralSigner } from "./testing/ephemeral-signer.js";
import { MockTechnocore } from "./testing/mock-technocore.js";

const C = contest();
const ROOM = "d-cc-live-test";
const at = (n: number) => sweepTime(C, n) - 20_000;
const folds: OfficialFold[] = [];
after(() => folds.forEach((f) => f.stop()));
const priceOf = (events: { kind: string; post?: unknown }[]) => events.find((e) => e.kind === "price")!.post as PricePost;

async function newFolds() {
  const main = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  const look = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  folds.push(main, look);
  return { main, look };
}

interface World { db: CcDb; feed: RefereeFeed; srv: MockTechnocore; signers: Map<string, Signer>; clock: { t: number } }

/** Real (fake = 0) keys, READY after a PROTOCOL-confirmed mint, our room READY on the mock server. */
function liveWorld(nKeys = 4): World {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed("226.14");
  feed.sweep(1, { close: "226.00", applied: "226.14", owners: 0, prevOwners: 0 });
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
  const clock = { t: at(2) };
  srv.clock = () => clock.t;
  return { db, feed, srv, signers, clock };
}

function executor(w: World): LiveExecutor {
  const journal = new WriteJournal(w.db, w.signers, w.srv, { clock: () => w.clock.t });
  return new LiveExecutor(w.db, w.signers, journal, w.srv, ROOM, C, 3_000, () => w.clock.t);
}

async function engine(w: World, exec: TradeExecutor, keyCount: number) {
  const { main, look } = await newFolds();
  const p = new PaperTrader(w.db, testConfig({ CLOSECALL_KEY_COUNT: String(keyCount), CLOSECALL_ROOM: ROOM }), C, main, look, null, exec);
  p.clock = () => w.clock.t;
  await p.start();
  return p;
}

/** Live world, keys entered in the book at sweep 2, ready to decide sweep 3. */
async function readyLive(nKeys = 4, exec?: (w: World) => TradeExecutor) {
  const w = liveWorld(nKeys);
  const ex = exec ? exec(w) : executor(w);
  const p = await engine(w, ex, nKeys);
  await p.settle(2, priceOf(w.feed.sweep(2, { close: "226.00", applied: "226.00", owners: 5, prevOwners: 0 })));
  w.clock.t = at(3) + 500;
  return { w, p, ex };
}

const tradesIn = (w: World) => (w.srv.rooms.get(ROOM) ?? []).map((m) => JSON.parse(m.text) as { t: string; terms: Terms; taker: string; maker_sig: string; taker_sig: string });
const liveRows = (db: CcDb) => db.prepare("SELECT * FROM live_trades ORDER BY created_at").all() as Record<string, string>[];

test("paper and live: Strategy K produces the SAME intent (pair, side, trigger, px, qty, until) -- only execution differs", async () => {
  const { db: pdb } = tmpDb();
  const pfeed = new RefereeFeed(pdb);
  pfeed.seed("226.14");
  pfeed.sweep(1, { close: "226.00", applied: "226.14", owners: 0, prevOwners: 0 });
  const { main, look } = await newFolds();
  const paper = new PaperTrader(pdb, testConfig({ CLOSECALL_KEY_COUNT: "4" }), C, main, look, null);
  await paper.start();
  await paper.settle(2, priceOf(pfeed.sweep(2, { close: "226.00", applied: "226.00", owners: 5, prevOwners: 0 })));
  const pi = await paper.decide(3, true, at(3));

  const { w, p } = await readyLive(4);
  const li = await p.decide(3, true, at(3));
  const fields = (x: typeof pi) => x.map((i) => JSON.stringify([i.sweep, i.intent.pairIndex, i.intent.favored, i.intent.trigger, i.wire.side, i.wire.px, i.wire.qty, i.wire.until]));
  assert.equal(pi.length, 2);
  assert.deepEqual(fields(li), fields(pi), "byte-identical decision fields");
  assert.equal(tradesIn(w).length, 2, "live posted both; paper posted nothing (it cannot)");
});

test("live: signed once by maker and taker (both verify), posted once, nonce persisted; duplicates and restarts never re-post", async () => {
  const { w, p, ex } = await readyLive(4);
  const intents = await p.decide(3, true, at(3));
  const posted = tradesIn(w);
  assert.equal(posted.length, 2);
  for (const t of posted) {
    assert.ok(verifyEd25519(t.terms.maker, t.maker_sig, makerSigningString(t.terms)), "maker signature");
    assert.ok(verifyEd25519(t.taker, t.taker_sig, takerSigningString(t.terms, t.taker)), "taker signature");
  }
  const rows = liveRows(w.db);
  assert.deepEqual(rows.map((r) => r.state), ["POSTED", "POSTED"]);
  assert.ok(rows.every((r) => r.sign_start && r.sign_end && r.post_at && r.response_at && r.decided_at), "timings recorded");
  const n1 = w.db.prepare("SELECT signer_id, scope, last_nonce FROM nonces ORDER BY signer_id").all() as { signer_id: string; scope: string; last_nonce: string }[];
  assert.ok(n1.length >= 1 && n1.every((x) => x.scope === `room:${ROOM}`));
  // the same intent again: refused as already executed
  const again = await ex.post(p.execIntent(intents[0], at(3)), async () => []);
  assert.equal(again.posted, true);
  assert.match(again.detail, /never posted twice/);
  // full restart of the engine + executor: nothing new is posted, same trade ids
  const posts = w.srv.posts;
  await engine(w, executor(w), 4);
  assert.equal(w.srv.posts, posts);
  assert.deepEqual(liveRows(w.db).map((r) => r.trade_id), rows.map((r) => r.trade_id));
  // a later write by the same key reserves a strictly higher nonce (persisted, not in memory)
  const j = new WriteJournal(w.db, w.signers, w.srv, { clock: () => w.clock.t });
  const next = j.reserveNonce(n1[0].signer_id, n1[0].scope);
  assert.ok(BigInt(next) > BigInt(n1[0].last_nonce));
});

test("crash BEFORE the POST: on restart the SAME trade (same id, same signed text) is posted exactly once", async () => {
  const { w, p } = await readyLive(4);
  const crash: TradeExecutor = {
    live: true,
    post: async (i, pre) => { await executor(w).post(i, async () => { await pre(); throw new Error("process killed"); }); return { posted: false, state: "", detail: "" }; },
    has: () => false,
  };
  (p as unknown as { exec: TradeExecutor }).exec = crash;
  await assert.rejects(p.decide(3, true, at(3)), /process killed/);
  assert.deepEqual(liveRows(w.db).map((r) => r.state), ["CREATED"]);
  assert.equal(tradesIn(w).length, 0);
  const id = liveRows(w.db)[0].trade_id;
  await engine(w, executor(w), 4);                                             // restart: recovery
  const after1 = liveRows(w.db);
  assert.equal(after1.find((r) => r.trade_id === id)!.state, "POSTED");
  assert.equal(tradesIn(w).filter((t) => t.terms.id === id).length, 1, "posted once, same trade id");
});

test("crash DURING the HTTP request (server stored it): restart resolves by read-back only, never a second copy", async () => {
  const { w, p } = await readyLive(2);
  await p.decide(3, true, at(3));
  const [row] = liveRows(w.db);
  // rewind to the moment the process died mid-request
  w.db.prepare("UPDATE live_trades SET state = 'POSTING' WHERE intent_id = ?").run(row.intent_id);
  w.db.prepare("UPDATE write_attempts SET state = 'SENDING' WHERE op_key = ?").run(row.attempt_op);
  const posts = w.srv.posts;
  await engine(w, executor(w), 2);
  assert.equal(liveRows(w.db)[0].state, "POSTED");
  assert.equal(w.srv.posts, posts, "read-back only");
  assert.equal(tradesIn(w).length, 1);
});

test("timeout AFTER the server committed: read-back finds it -> POSTED, one copy, no halt", async () => {
  const { w, p } = await readyLive(2);
  w.srv.failNext("timeout-after-commit");
  await p.decide(3, true, at(3));
  assert.equal(liveRows(w.db)[0].state, "POSTED");
  assert.equal(tradesIn(w).length, 1);
  assert.equal(Object.keys(activeHalts(w.db)).length, 0);
});

test("timeout BEFORE the server stored it: UNKNOWN, no new entries, NEVER re-sent (not even after a restart); resolved by evidence after the boundary", async () => {
  const { w, p } = await readyLive(2);
  w.srv.failNext("timeout-before-commit");
  await p.decide(3, true, at(3));
  assert.equal(liveRows(w.db)[0].state, "UNKNOWN");
  assert.equal(tradesIn(w).length, 0);
  assert.ok(activeHalts(w.db).unknown_trade, "no new entries while unknown; the observer keeps running");
  const p2 = await engine(w, executor(w), 2);                                  // restart: still never re-sent
  assert.equal(tradesIn(w).length, 0);
  assert.equal(liveRows(w.db)[0].state, "UNKNOWN");
  const price = priceOf(w.feed.sweep(3, { close: "226.10", applied: "226.00", owners: 10, prevOwners: 5 }));
  await p2.settle(3, price);                                                   // before boundary + grace: deferred
  assert.equal(liveRows(w.db)[0].state, "UNKNOWN");
  assert.ok(p2.deferred.has(3));
  w.clock.t = sweepTime(C, 3) + 31_000;
  await p2.retryDeferred();
  assert.equal(liveRows(w.db)[0].state, "NOT_APPLIED", "absent after the boundary -> never settles -> kept out of the book");
  assert.match(liveRows(w.db)[0].detail, /absent after the boundary/);
  assert.equal(activeHalts(w.db).unknown_trade, undefined, "resolved: the halt clears itself");
  assert.equal(p2.state.retries.length, 1, "the pair is released for a retry only now");
  assert.equal(tradesIn(w).length, 0, "nothing was ever re-sent");
});

test("stale sweep: past the posting deadline nothing is signed or sent; the pair is released for a retry", async () => {
  const { w, p } = await readyLive(2);
  w.clock.t = sweepTime(C, 3) - 1_000;                                        // inside the 3 s guard
  const sent = await p.decide(3, true, at(3));
  assert.equal(sent.length, 0);
  assert.equal(liveRows(w.db)[0].state, "NOT_POSTED");
  assert.equal(liveRows(w.db)[0].text, null, "never signed");
  assert.equal(w.srv.posts, 0);
  assert.equal((w.db.prepare("SELECT risk_status FROM intents").get() as { risk_status: string }).risk_status, "NOT_SENT");
});

/** An executor that runs the engine's real pre-POST check after `mutate`, and records what it said. */
function probeExec(mutate: (w: World, p: PaperTrader) => void, sink: string[][], ref: { w?: World; p?: PaperTrader }): (w: World) => TradeExecutor {
  return (w) => ({ live: true, post: async (_i: ExecIntent, pre) => { mutate(w, ref.p!); sink.push(await pre()); return { posted: false, state: "NOT_POSTED", detail: "probe" }; } });
}

test("pre-POST re-validation: balance changed, referee went stale, Hyperliquid halt -> NO POST", async () => {
  const cases: [string, (w: World, p: PaperTrader) => void, RegExp][] = [
    ["balance", (_w, p) => { for (const a of p.ledger.accounts.values()) a.cash = 0n; }, /funds@/],
    ["referee stale", (w) => { w.db.prepare("UPDATE sweeps SET age_s = 400 WHERE n = 2").run(); }, /stale policy: referee age_s 400/],
    ["HL stale", (w) => { halt(w.db, "hyperliquid_stale", "last xyz:NVDA trade seen 700 s ago"); }, /halted: HALTED: hyperliquid_stale/],
  ];
  for (const [name, mutate, re] of cases) {
    const sink: string[][] = [];
    const ref: { p?: PaperTrader } = {};
    const { w, p } = await readyLive(2, probeExec(mutate, sink, ref));
    ref.p = p;
    const sent = await p.decide(3, true, at(3));
    assert.equal(sent.length, 0, name);
    assert.ok(sink[0].some((f) => re.test(f)), `${name}: ${JSON.stringify(sink[0])}`);
    assert.equal(w.srv.posts, 0);
  }
});

test("safe mode: while halted, no intent reaches the executor", async () => {
  const { w, p } = await readyLive(2);
  halt(w.db, "manual", "operator stop");
  assert.deepEqual(await p.decide(3, true, at(3)), []);
  assert.equal(w.srv.posts, 0);
});

test("settlement: the fold settles our posted trade; the referee's listing agrees -> SETTLED, verified", async () => {
  const { w, p } = await readyLive(2);
  const [t] = await p.decide(3, true, at(3));
  const ev = w.feed.sweep(3, { close: "226.10", applied: "226.00", owners: 10, prevOwners: 5 });
  await p.settle(3, priceOf(ev));
  assert.equal(liveRows(w.db)[0].state, "SETTLED");
  w.db.prepare("INSERT INTO settled_ids (id, n) VALUES (?, 3)").run(t.wire.id);
  assert.deepEqual(p.verifyWithReferee(), { checked: 1, mismatches: 0 });
  assert.equal(liveRows(w.db)[0].referee_outcome, "settled");
});

test("void: the referee voids a trade our fold settled -> MISMATCH, grave halt", async () => {
  const { w, p } = await readyLive(2);
  const [t] = await p.decide(3, true, at(3));
  await p.settle(3, priceOf(w.feed.sweep(3, { close: "226.10", applied: "226.00", owners: 10, prevOwners: 5 })));
  w.db.prepare("INSERT INTO void_ids (id, n, reason) VALUES (?, 3, 'funds')").run(t.wire.id);
  assert.equal(p.verifyWithReferee().mismatches, 1);
  assert.ok(activeHalts(w.db).reconcile_mismatch);
  assert.equal(liveRows(w.db)[0].referee_outcome, "void:funds");
});

test("unlisted: the referee's truncated lists do not mention our id -> 'unlisted', no false alarm", async () => {
  const { w, p } = await readyLive(2);
  await p.decide(3, true, at(3));
  await p.settle(3, priceOf(w.feed.sweep(3, { close: "226.10", applied: "226.00", owners: 10, prevOwners: 5 })));
  assert.deepEqual(p.verifyWithReferee(), { checked: 1, mismatches: 0 });
  assert.equal(liveRows(w.db)[0].referee_outcome, "unlisted");
});

test("confirmation: a posted trade is located in our room and stamped before its boundary -> CONFIRMED", async () => {
  const { w, p, ex } = await readyLive(2);
  await p.decide(3, true, at(3));
  assert.equal(await (ex as LiveExecutor).confirmPosted(), 1);
  const r = liveRows(w.db)[0];
  assert.equal(r.state, "CONFIRMED");
  assert.ok(Date.parse(r.stamped_at) < sweepTime(C, 3));
});

test("100 keys: several triggers over several sweeps with a restart in the middle -- every accepted intent posted exactly once", async () => {
  let { w, p } = await readyLive(100);
  const closes = ["226.00", "225.10", "224.40", "223.70", "223.00"];
  for (let n = 3; n <= 7; n++) {
    w.clock.t = at(n) + 500;
    await p.decide(n, true, at(n));
    await p.settle(n, priceOf(w.feed.sweep(n, { close: closes[n - 3], applied: n === 3 ? "226.00" : closes[n - 4], owners: 10 * n, prevOwners: 10 * (n - 1) })));
    if (n === 5) p = await engine(w, executor(w), 100);                       // restart mid-season
  }
  const rows = liveRows(w.db);
  const posted = tradesIn(w);
  assert.ok(rows.length >= 4, `triggers: ${rows.length} ${JSON.stringify(rows.map((r) => [r.sweep, r.pair_index, r.state, r.detail]))} ${JSON.stringify(w.db.prepare("SELECT sweep, trigger, decision, detail FROM strategy_triggers").all())}`);
  assert.equal(new Set(posted.map((t) => t.terms.id)).size, posted.length, "no trade id posted twice");
  assert.equal(posted.length, rows.filter((r) => ["POSTED", "CONFIRMED", "SETTLED", "VOID"].includes(r.state)).length);
  for (const t of posted) assert.ok(verifyEd25519(t.terms.maker, t.maker_sig, makerSigningString(t.terms)));
  const pairs = rows.map((r) => r.pair_index);
  assert.equal(new Set(pairs).size, pairs.length, "each pair used once");
});

test("pair fates: FAILED (refused, nothing stored) and NOT_POSTED release the pair; SETTLED never re-trades it; UNKNOWN blocks it until resolved", async () => {
  const { w, p } = await readyLive(2);
  w.srv.failNext("403");
  const sent = await p.decide(3, true, at(3));
  assert.equal(sent.length, 0);
  assert.equal(liveRows(w.db)[0].state, "FAILED");
  assert.equal(p.state.retries.length, 1, "FAILED: nothing was stored -> the pair is free for a retry (fresh id)");
  assert.equal(Object.keys(activeHalts(w.db)).length, 0, "a definitive refusal is not a halt");
  // the retry at the next sweep uses a NEW trade id on the same (flat) pair
  await p.settle(3, priceOf(w.feed.sweep(3, { close: "226.00", applied: "226.00", owners: 10, prevOwners: 5 })));
  w.clock.t = at(4) + 500;
  const again = await p.decide(4, true, at(4));
  assert.equal(again.length, 1);
  assert.notEqual(again[0].wire.id, liveRows(w.db)[0].trade_id);
  assert.equal(liveRows(w.db).at(-1)!.state, "POSTED");
});
