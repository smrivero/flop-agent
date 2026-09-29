/**
 * CONTRA (strategy/contra.ts): the pure state machine, the engine in paper mode (Strategy K unchanged, CONTRA only on
 * its reserved keys), and the live path through the REAL LiveExecutor against the in-memory technocore: signed and
 * posted once, crash before POST, timeout -> UNKNOWN never re-sent, restart, kill switch, virgin-key check.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sweepTime } from "./contest.js";
import { toMicro } from "./decimal.js";
import type { Estimate } from "./estimator.js";
import { OfficialFold } from "./fold.js";
import { WriteJournal } from "./journal.js";
import { keyId } from "./keys.js";
import { LiveExecutor } from "./live/executor.js";
import { foldConfig, PaperTrader, type TradeExecutor } from "./paper.js";
import type { PricePost, Terms } from "./protocol.js";
import type { Signer } from "./protocol-writes.js";
import { activeHalts } from "./safety.js";
import { contraDecide, contraInitial, contraPending, contraResolved, contraSpecs, contraUsedKeys, type ContraState } from "./strategy/contra.js";
import { loadStrategyState, now, type CcDb } from "./store.js";
import { contest, RefereeFeed, testConfig, tmpDb, VENDOR } from "./test-helpers.js";
import { ephemeralSigner } from "./testing/ephemeral-signer.js";
import { MockTechnocore } from "./testing/mock-technocore.js";

const C = contest();
const folds: OfficialFold[] = [];
after(() => folds.forEach((f) => f.stop()));
const at = (n: number) => sweepTime(C, n) - 20_000;
const priceOf = (events: { kind: string; post?: unknown }[]) => events.find((e) => e.kind === "price")!.post as PricePost;
const est = (v: string): Estimate => ({ value: toMicro(v), used: "hl", stale: false, reason: "test" });
const Q = 43_000_000n;                                                                // 43 contracts in micro-units

// ------------------------------------------------------------------ pure state machine
const KEYS = Array.from({ length: 40 }, (_, i) => `CC${String(61 + i).padStart(3, "0")}`);
const SPECS = contraSpecs(KEYS, 19);
const decide = (s: ContraState, e: number, pos: Record<string, bigint> = {}, sweep = 100) => contraDecide(s, SPECS, { sweep, estimate: e, lockSweep: 2556, positions: pos });

test("CONTRA layout: champion LONG CC061 + CC062..CC080, champion SHORT CC081 + CC082..CC100", () => {
  assert.equal(SPECS[0].champion, "CC061");
  assert.deepEqual([SPECS[0].counterparties[0], SPECS[0].counterparties.at(-1)], ["CC062", "CC080"]);
  assert.equal(SPECS[1].champion, "CC081");
  assert.deepEqual([SPECS[1].counterparties[0], SPECS[1].counterparties.at(-1)], ["CC082", "CC100"]);
  assert.throws(() => contraSpecs(KEYS.slice(1), 19), /needs 40 keys/);
});

test("CONTRA: open both champions; nothing below the threshold; +0.25% -> close + reopen with two NEW counterparties", () => {
  let r = decide(contraInitial(SPECS), 228);
  assert.deepEqual(r.intents.map((i) => [i.champion, i.leg, i.dir, i.championId, i.counterpartyId]), [["long", "open", 1, "CC061", "CC062"], ["short", "open", -1, "CC081", "CC082"]]);
  let s = r.state;
  const pos = { CC061: Q, CC081: -Q };
  r = decide(s, 228 * 1.0024, pos);
  assert.equal(r.intents.length, 0, "below the threshold for both");
  r = decide(s, 228 * 1.0026, pos);                                                   // long takes profit; short does not
  assert.deepEqual(r.intents.map((i) => [i.champion, i.leg, i.dir, i.counterpartyId, i.qtyCap]), [["long", "close", -1, "CC063", Q.toString()], ["long", "reopen", -1, "CC064", null]]);
  s = r.state;
  assert.equal(s.champions[0].flips, 1);
  assert.equal(s.champions[0].want, -1);
  r = decide(s, 228 * 0.997, pos);                                                    // short champion takes profit
  assert.deepEqual(r.intents.map((i) => [i.champion, i.leg, i.dir, i.counterpartyId]), [["short", "close", 1, "CC083"], ["short", "reopen", 1, "CC084"]]);
});

test("CONTRA: a champion with a leg awaiting settlement decides nothing until it is resolved", () => {
  let s = decide(contraInitial(SPECS), 228).state;
  s = contraPending(s, "long", "i1");
  const r = decide(s, 240, { CC061: Q, CC081: -Q });
  assert.deepEqual(r.intents.map((i) => i.champion), [], "short: no trigger at 240; long: blocked by its pending leg");
  assert.equal(decide(contraResolved(s, "i1"), 240, { CC061: Q, CC081: -Q }).intents[0].champion, "long");
});

test("CONTRA: 19 counterparties = 1 open + 9 flips; then it HOLDS until S; no counterparty is ever used twice", () => {
  let s = decide(contraInitial(SPECS), 100).state;
  const used: string[] = ["CC062", "CC082"];
  let px = 100, long = true;
  for (let i = 0; i < 20; i++) {
    px = long ? px * 1.003 : px * 0.997;
    const r = decide(s, px, { CC061: long ? Q : -Q, CC081: -Q });
    const mine = r.intents.filter((x) => x.champion === "long");
    used.push(...r.intents.map((x) => x.counterpartyId));
    s = r.state;
    if (i < 9) { assert.equal(mine.length, 2, `flip ${i + 1}`); long = !long; } else assert.equal(mine.length, 0, "exhausted: holds");
  }
  assert.equal(s.champions[0].next, 19);
  assert.equal(s.champions[0].flips, 9);
  assert.ok(s.champions[0].exhausted);
  assert.equal(new Set(used).size, used.length, "never reused");
  assert.ok(used.every((k) => KEYS.includes(k) && k !== "CC061" && k !== "CC081"), "only the reserved counterparties");
  assert.equal(contraUsedKeys(s, SPECS).size, used.length + 2);
});

test("CONTRA: flat after a voided leg -> reopens in the wanted direction with the NEXT counterparty; nothing after the lock", () => {
  let s = decide(contraInitial(SPECS), 228).state;
  const r = decide(s, 228, { CC061: 0n, CC081: -Q });                                  // the long's open was voided
  assert.deepEqual(r.intents.map((i) => [i.champion, i.leg, i.dir, i.counterpartyId]), [["long", "reopen", 1, "CC063"]]);
  s = r.state;
  assert.equal(decide(s, 300, { CC061: Q, CC081: -Q }, 2557).intents.length, 0);
});

// ------------------------------------------------------------------ engine, paper mode
const CONTRA_ENV = { CLOSECALL_KEY_COUNT: "100", CLOSECALL_CONTRA_KEYS: "CC061-CC100" };

async function paperEngine(env: Record<string, string>) {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed("226.14");
  feed.sweep(1, { close: "226.00", applied: "226.14", owners: 0, prevOwners: 0 });
  const main = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  const look = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  folds.push(main, look);
  const p = new PaperTrader(db, testConfig(env), C, main, look, null);
  await p.start();
  await p.settle(2, priceOf(feed.sweep(2, { close: "226.00", applied: "226.00", owners: 100, prevOwners: 0 })));
  return { db, feed, p };
}

/** Run sweeps 3.. with the given estimates (the close = the estimate, as the recorded estimator mostly is). */
async function drive(e: { db: CcDb; feed: RefereeFeed; p: PaperTrader }, closes: string[]) {
  const intents: { n: number; trigger: string; buyer: string; seller: string; px: string; qty: string }[] = [];
  let prev = "226.00";
  for (const [i, c] of closes.entries()) {
    const n = 3 + i;
    e.p.estimateHook = () => est(c);
    const sent = await e.p.decide(n, true, at(n));
    intents.push(...sent.map((s) => ({ n, trigger: s.intent.trigger, buyer: s.buyerId, seller: s.sellerId, px: s.wire.px, qty: s.wire.qty })));
    await e.p.settle(n, priceOf(e.feed.sweep(n, { close: c, applied: prev, owners: 100, prevOwners: 100 })));
    prev = c;
  }
  return intents;
}
const PATH = ["226.00", "226.30", "226.70", "227.20", "226.50", "225.60", "225.00", "225.90", "226.80"];

test("engine: with CONTRA reserved, K trades only CC001..CC060 and makes the SAME decisions with CONTRA on or off", async () => {
  const off = await paperEngine({ CLOSECALL_KEY_COUNT: "100", CLOSECALL_CONTRA_KEYS: "CC061-CC100" });
  const on = await paperEngine({ ...CONTRA_ENV, CLOSECALL_CONTRA_ENABLED: "true" });
  assert.equal(off.p.keys.length, 60);
  assert.equal(off.p.keys.at(-1)!.id, "CC060");
  assert.equal(on.p.contraOff, null);
  const a = await drive(off, PATH), b = await drive(on, PATH);
  const k = (xs: typeof a) => xs.filter((x) => !x.trigger.startsWith("contra-")).map((x) => JSON.stringify([x.n, x.trigger, x.buyer, x.seller, x.px, x.qty]));
  assert.deepEqual(k(b), k(a), "K intents identical, field by field");
  assert.ok(a.every((x) => !x.trigger.startsWith("contra-")), "kill switch off: no CONTRA intent");
  const contra = b.filter((x) => x.trigger.startsWith("contra-"));
  assert.ok(contra.length >= 4, `CONTRA traded (${contra.length} legs)`);
  const reserved = new Set(CONTRA_ENV.CLOSECALL_CONTRA_KEYS && Array.from({ length: 40 }, (_, i) => keyId(61 + i)));
  assert.ok(contra.every((x) => reserved.has(x.buyer) && reserved.has(x.seller)), "CONTRA legs only on its reserved keys");
  assert.ok(b.filter((x) => !x.trigger.startsWith("contra-")).every((x) => !reserved.has(x.buyer) && !reserved.has(x.seller)), "K never touches them");
  const cps = contra.map((x) => (x.buyer === "CC061" || x.buyer === "CC081" ? x.seller : x.buyer));
  assert.equal(new Set(cps).size, cps.length, "every leg a new counterparty");
  const st = loadStrategyState<ContraState>(on.db, "CONTRA")!;
  assert.ok(st.champions.some((c) => c.flips >= 1), "at least one take-profit reversal");
  assert.ok(st.champions.every((c) => c.pending.length === 0), "all legs resolved");
  const recon = on.db.prepare("SELECT COUNT(*) n FROM reconcile WHERE status <> 'OK' AND level LIKE 'L2%'").get() as { n: number };
  assert.equal(recon.n, 0, "official fold == mirror on every account, CONTRA included");
});

test("engine: a flip settles as close + reopen: the champion goes from +q to -q' and realizes the move", async () => {
  const on = await paperEngine({ ...CONTRA_ENV, CLOSECALL_CONTRA_ENABLED: "true" });
  await drive(on, ["226.00", "226.60"]);                                              // +0.27% -> long champion flips at 226.60
  const champ = on.p.ledger.accounts.get(on.p.contraKeys[0].did)!;
  assert.ok(champ.position < 0n, "long champion is now short");
  const value = Number(champ.valueAt(toMicro("226.60"))) / 1e6 - 10_000;
  assert.ok(value > 20, `realized ~ q x 0.60 = ~+25 (got ${value.toFixed(2)})`);
});

// ------------------------------------------------------------------ live path: the real LiveExecutor
const ROOM = "d-cc-contra-test";
interface World { db: CcDb; feed: RefereeFeed; srv: MockTechnocore; signers: Map<string, Signer>; clock: { t: number } }
const LIVE_ENV = { CLOSECALL_KEY_COUNT: "12", CLOSECALL_ROOM: ROOM, CLOSECALL_CONTRA_KEYS: "CC005-CC012", CLOSECALL_CONTRA_COUNTERPARTIES: "3", CLOSECALL_CONTRA_ENABLED: "true" };

function liveWorld(): World {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed("226.14");
  feed.sweep(1, { close: "226.00", applied: "226.14", owners: 0, prevOwners: 0 });
  const signers = new Map<string, Signer>();
  for (let i = 1; i <= 12; i++) {
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
const executor = (w: World) => new LiveExecutor(w.db, w.signers, new WriteJournal(w.db, w.signers, w.srv, { clock: () => w.clock.t }), w.srv, ROOM, C, 3_000, () => w.clock.t);
async function engine(w: World, exec: TradeExecutor, env: Record<string, string> = LIVE_ENV) {
  const main = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  const look = await OfficialFold.start("python3", VENDOR, foldConfig(C));
  folds.push(main, look);
  const p = new PaperTrader(w.db, testConfig(env), C, main, look, null, exec);
  p.clock = () => w.clock.t;
  await p.start();
  return p;
}
async function readyLive(env: Record<string, string> = LIVE_ENV, exec?: (w: World) => TradeExecutor) {
  const w = liveWorld();
  const p = await engine(w, exec ? exec(w) : executor(w), env);
  await p.settle(2, priceOf(w.feed.sweep(2, { close: "226.00", applied: "226.00", owners: 12, prevOwners: 0 })));
  w.clock.t = at(3) + 500;
  p.estimateHook = () => est("226.00");
  return { w, p };
}
const tradesIn = (w: World) => (w.srv.rooms.get(ROOM) ?? []).map((m) => JSON.parse(m.text) as { t: string; terms: Terms; taker: string });
const liveRows = (db: CcDb) => db.prepare("SELECT * FROM live_trades ORDER BY created_at").all() as Record<string, string>[];
const contraRows = (db: CcDb) => liveRows(db).filter((r) => r.intent_id.includes("-contra-"));

test("live: CONTRA legs go through the LiveExecutor -- signed, posted once, journaled; restart never re-posts; counterparties persisted", async () => {
  const { w, p } = await readyLive();
  const sent = await p.decide(3, true, at(3));
  assert.deepEqual(sent.filter((s) => s.contra).map((s) => [s.contra!.champion, s.contra!.leg, s.buyerId, s.sellerId]),
    [["long", "open", "CC005", "CC006"], ["short", "open", "CC010", "CC009"]], "long champion buys from CC006; short champion sells to CC010");
  assert.deepEqual(contraRows(w.db).map((r) => r.state), ["POSTED", "POSTED"]);
  const posts = w.srv.posts;
  const p2 = await engine(w, executor(w));
  assert.equal(w.srv.posts, posts, "restart: nothing re-posted");
  assert.deepEqual(p2.contraState!.champions.map((c) => [c.next, c.pending.length]), [[1, 1], [1, 1]], "cps consumed and legs pending, rebuilt from the stored intents");
  p2.estimateHook = () => est("226.00");
  const again = await p2.decide(3, true, at(3));
  assert.equal(again.filter((s) => s.contra).length, 0, "a champion with a pending leg decides nothing");
});

test("live: crash BEFORE the POST of a CONTRA leg -> on restart the SAME trade is posted exactly once; its counterparty is not reused", async () => {
  const w0 = liveWorld();
  let calls = 0;
  const crash: TradeExecutor = {
    live: true,
    post: async (i, pre) => {
      if (!i.intentId.includes("-contra-")) return executor(w0).post(i, pre);
      calls++;
      await executor(w0).post(i, async () => { await pre(); throw new Error("process killed"); });
      return { posted: false, state: "", detail: "" };
    },
    has: () => false,
  };
  const p = await engine(w0, crash);
  await p.settle(2, priceOf(w0.feed.sweep(2, { close: "226.00", applied: "226.00", owners: 12, prevOwners: 0 })));
  w0.clock.t = at(3) + 500;
  p.estimateHook = () => est("226.00");
  await assert.rejects(p.decide(3, true, at(3)), /process killed/);
  assert.equal(calls, 1);
  const row = contraRows(w0.db)[0];
  assert.equal(row.state, "CREATED");
  assert.equal((loadStrategyState<ContraState>(w0.db, "CONTRA")!).champions[0].next, 1, "counterparty consumed before the POST");
  await engine(w0, executor(w0));                                                      // restart: recovery
  assert.equal(contraRows(w0.db).find((r) => r.trade_id === row.trade_id)!.state, "POSTED");
  assert.equal(tradesIn(w0).filter((t) => t.terms.id === row.trade_id).length, 1, "posted once, same trade id");
});

test("live: CONTRA leg times out before the server stores it -> UNKNOWN, never re-sent, champion blocked; resolved by evidence -> NOT_APPLIED, counterparty stays burned", async () => {
  const { w, p } = await readyLive();
  const exec = executor(w);
  (p as unknown as { exec: TradeExecutor }).exec = {
    live: true, has: (id) => exec.has(id), admissible: (id, n) => exec.admissible(id, n), onSettled: (id, o, r) => exec.onSettled(id, o, r), recover: (x) => exec.recover(x),
    post: async (i, pre) => { if (i.intentId.includes("-contra-long-")) w.srv.failNext("timeout-before-commit"); return exec.post(i, pre); },
  };
  await p.decide(3, true, at(3));
  const long = contraRows(w.db).find((r) => r.intent_id.includes("-contra-long-"))!;
  assert.equal(long.state, "UNKNOWN");
  assert.ok(activeHalts(w.db).unknown_trade, "no new entries while unknown");
  assert.equal(tradesIn(w).filter((t) => t.terms.id === long.trade_id).length, 0);
  const p2 = await engine(w, executor(w));                                             // restart: never re-sent
  assert.equal(tradesIn(w).filter((t) => t.terms.id === long.trade_id).length, 0);
  assert.equal(p2.contraState!.champions[0].pending.length, 1, "long champion blocked by its unknown leg");
  await p2.settle(3, priceOf(w.feed.sweep(3, { close: "226.10", applied: "226.00", owners: 12, prevOwners: 12 })));
  w.clock.t = sweepTime(C, 3) + 31_000;
  await p2.retryDeferred();
  assert.equal(contraRows(w.db).find((r) => r.trade_id === long.trade_id)!.state, "NOT_APPLIED");
  assert.equal(p2.contraState!.champions[0].pending.length, 0, "freed");
  assert.equal(p2.contraState!.champions[0].next, 1, "its counterparty stays consumed");
  assert.equal(tradesIn(w).filter((t) => t.terms.id === long.trade_id).length, 0, "nothing was ever re-sent");
});

test("live: kill switch off -> no CONTRA intent, reserved keys untouched, K unchanged on the others", async () => {
  const { w, p } = await readyLive({ ...LIVE_ENV, CLOSECALL_CONTRA_ENABLED: "false" });
  assert.match(p.contraOff!, /CONTRA_ENABLED is false/);
  const sent = await p.decide(3, true, at(3));
  assert.equal(sent.filter((s) => s.contra).length, 0);
  assert.ok(sent.length > 0 && sent.every((s) => ["CC001", "CC002", "CC003", "CC004"].includes(s.buyerId)), "K on CC001..CC004 only");
  assert.equal(contraRows(w.db).length, 0);
});

test("live: a reserved key that already traded (not virgin) -> CONTRA stays OFF; K keeps trading", async () => {
  const w = liveWorld();
  w.db.prepare(`INSERT INTO intents (intent_id, sweep, pair_index, trigger, favored, maker_id, taker_id, maker_did, taker_did, side, qty, px, until, ref, estimated_close, trade_id, risk_status, created_at, outcome)
    VALUES ('x', 1, 0, 'new-low', 'long', 'CC007', 'CC004', 'd', 'd', 'buy', '1', '1', 1, '1', '1', 't', 'OK', ?, 'settled')`).run(now());
  const p = await engine(w, executor(w));
  assert.match(p.contraOff!, /not virgin: CC007: already in 1 trade/);
  await p.settle(2, priceOf(w.feed.sweep(2, { close: "226.00", applied: "226.00", owners: 12, prevOwners: 0 })));
  w.clock.t = at(3) + 500;
  p.estimateHook = () => est("226.00");
  const sent = await p.decide(3, true, at(3));
  assert.equal(sent.filter((s) => s.contra).length, 0);
  assert.ok(sent.length > 0, "K still trades");
});

test("CONTRA per champion: its own threshold and its own counterparty count (layout long, cps, short, cps)", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `K${i}`);
  const specs = contraSpecs(keys, { long: 24, short: 14 }, { long: 0.0025, short: 0.01 });
  assert.deepEqual([specs[0].champion, specs[0].counterparties.length, specs[1].champion, specs[1].counterparties.length], ["K0", 24, "K25", 14]);
  let s = contraDecide(contraInitial(specs), specs, { sweep: 1, estimate: 100, lockSweep: 2556, positions: {} }).state;
  const r = contraDecide(s, specs, { sweep: 2, estimate: 99.5, lockSweep: 2556, positions: { K0: Q, K25: -Q } });
  assert.deepEqual(r.intents.map((i) => i.champion), [], "-0.5%: below the short champion's 1% and against the long");
  s = contraDecide(s, specs, { sweep: 2, estimate: 100.3, lockSweep: 2556, positions: { K0: Q, K25: -Q } }).state;
  assert.equal(s.champions[0].flips, 1, "+0.3%: the 0.25% long champion flips");
  assert.equal(s.champions[1].flips, 0, "the 1% short champion does not");
  assert.throws(() => contraSpecs(keys, 19, 0.0025).length && contraSpecs(keys.slice(1), 19), /needs 40 keys/);
});
