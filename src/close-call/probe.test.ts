/**
 * The idempotent mint probe, cases A-H, against the OFFICIAL fold (vendored, byte-identical).
 * Keys are simulation DIDs; nothing is signed or sent.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { OfficialFold, type FoldSweepResult } from "./fold.js";
import { paperDid } from "./keys.js";
import type { WireTrade } from "./ledger.js";
import { foldConfig } from "./paper.js";
import { planProbe, resolveProbe } from "./probe.js";
import { contest, tmpDb, VENDOR } from "./test-helpers.js";
import { MockTechnocore } from "./testing/mock-technocore.js";

const [A, B, X, Y] = ["P-A", "P-B", "P-X", "P-Y"].map(paperDid);   // A,B ours; X,Y an adversary
const ID = "f".repeat(32);
let fold: OfficialFold;
before(async () => { fold = await OfficialFold.start("python3", VENDOR, foldConfig(contest())); });
after(() => fold.stop());

async function fresh() {
  await fold.reset(foldConfig(contest()));
  await fold.seed("226.00");
}
const probe = (o: Partial<WireTrade> = {}): WireTrade => ({ id: ID, maker: A, side: "buy", qty: "0.10", px: "226.00", taker: B, until: 8, countersigner: B, ...o });
const out = (r: FoldSweepResult) => r.trades.map((t) => t.outcome + (t.reason ? ":" + t.reason : ""));
const pos = async (did: string) => (await fold.accounts([did], "226.00")).accounts[did];

test("A: first attempt void:not_owner, keys minted later, the SAME id retried settles", async () => {
  await fresh();
  assert.deepEqual(out(await fold.sweep(1, "226.00", "226.00", [], [probe()])), ["void:not_owner"]);
  assert.deepEqual(out(await fold.sweep(2, "226.00", "226.00", [A, B], [probe()])), ["settled"], "mints come first in a sweep, and a void never burned the id");
  assert.equal((await pos(A)).position, "0.10");
});

test("B: settled, then retried with the same id: void:settled and nothing changes", async () => {
  await fresh();
  await fold.sweep(1, "226.00", "226.00", [A, B], [probe()]);
  const before = await fold.accounts([A, B], "226.00");
  assert.deepEqual(out(await fold.sweep(2, "226.00", "227.00", [], [probe()])), ["void:settled"]);
  assert.deepEqual((await fold.accounts([A, B], "226.00")).accounts, before.accounts, "balances, lots and fees untouched");
});

test("C: HTTP timeout after posting -- re-posting the same id can never double the exposure", async () => {
  await fresh();
  await fold.sweep(1, "226.00", "226.00", [A, B], []);
  // unknown whether copy #1 arrived: both copies reach the referee in the same sweep ...
  assert.deepEqual(out(await fold.sweep(2, "226.00", "226.00", [], [probe(), probe()])), ["settled", "void:settled"]);
  // ... or in consecutive sweeps
  assert.deepEqual(out(await fold.sweep(3, "226.00", "226.00", [], [probe()])), ["void:settled"]);
  assert.equal((await pos(A)).position, "0.10");
});

test("D: a later void:settled is NOT proof that OUR trade settled -- anyone can reuse a published id", async () => {
  await fresh();
  // Our first attempt is voided (not yet minted) and the void list publishes the id.
  assert.deepEqual(out(await fold.sweep(1, "226.00", "226.00", [X, Y], [probe()])), ["void:not_owner"]);
  // An adversary, already an owner, settles its own trade under OUR id before our retry.
  const theirs = probe({ maker: X, taker: Y, countersigner: Y });
  assert.deepEqual(out(await fold.sweep(2, "226.00", "226.00", [A, B], [theirs, probe()])), ["settled", "void:settled"]);
  assert.equal((await pos(A)).position, "0", "our keys hold nothing ...");
  assert.equal((await pos(X)).position, "0.10", "... the settled id was the adversary's");
  // So: settled listing of the id / void:settled are strong evidence only if the id was never exposed unsettled.
});

test("E: until -- inside it the same terms settle; after it, a re-post is a pure query (settled vs expired)", async () => {
  await fresh();
  await fold.sweep(1, "226.00", "226.00", [A, B], []);
  assert.deepEqual(out(await fold.sweep(9, "226.00", "226.00", [], [probe({ until: 8 })])), ["void:expired"], "never settled -> expired");
  await fresh();
  await fold.sweep(1, "226.00", "226.00", [A, B], [probe({ until: 8 })]);
  assert.deepEqual(out(await fold.sweep(9, "226.00", "226.00", [], [probe({ until: 8 })])), ["void:settled"], "settled -> settled (checked before expiry)");
  assert.equal((await pos(A)).position, "0.10");
});

test("F: changing limits -- a limits void does not burn the id; the SAME terms settle once the price is back", async () => {
  await fresh();
  await fold.sweep(1, "226.00", "226.00", [A, B], []);
  assert.deepEqual(out(await fold.sweep(2, "240.00", "240.00", [], [probe()])), ["void:limits"]);
  assert.deepEqual(out(await fold.sweep(3, "226.50", "226.50", [], [probe()])), ["settled"]);
  // Hence the rule in planProbe: no new id for a pair while an old one is still inside its until.
  const { db } = tmpDb();
  planProbe(db, { pairIds: ["CC001", "CC002"], sweep: 10, ref: "226.00", window: 6 });
  assert.throws(() => planProbe(db, { pairIds: ["CC001", "CC002"], sweep: 12, ref: "226.00" }), /still live until sweep 16/);
});

test("G: duplicate-text protection: the 6th identical copy within 120 s is refused, spaced re-posts are accepted", async () => {
  const srv = new MockTechnocore();
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { didFromPublicKey } = await import("../identity.js");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const did = didFromPublicKey(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const text = JSON.stringify({ t: "trade", season: "close-1", terms: { id: ID }, taker: B, maker_sig: "x", taker_sig: "y" });
  const post = (nonce: number) => srv.post("/r/d-cc-test", { did, nonce: String(nonce), text,
    sig: sign(null, Buffer.from(`d-cc-test|${nonce}|${text}`), privateKey).toString("base64url") });
  let t = 1_000_000;
  srv.clock = () => t;
  for (let i = 1; i <= 5; i++) assert.equal((await post(i)).status, 200);
  assert.equal((await post(6)).status, 422, "6th copy inside the window");
  t += 5 * 60_000;                                            // next sweep
  assert.equal((await post(7)).status, 200, "a re-post one sweep later is accepted");
});

test("H: many retries across sweeps settle exactly once", async () => {
  await fresh();
  const results: string[] = [];
  for (let n = 1; n <= 6; n++) results.push(...out(await fold.sweep(n, "226.00", "226.00", n === 3 ? [A, B] : [], [probe({ until: 20 })])));
  assert.deepEqual(results, ["void:not_owner", "void:not_owner", "settled", "void:settled", "void:settled", "void:settled"]);
  assert.equal((await pos(A)).position, "0.10");
});

test("a new probe for the same pair reverses direction: two settled probes net to zero exposure", async () => {
  await fresh();
  await fold.sweep(1, "226.00", "226.00", [A, B], [probe({ id: "1".repeat(32) })]);
  await fold.sweep(2, "226.00", "226.00", [], [probe({ id: "2".repeat(32), maker: B, taker: A, countersigner: A })]);
  assert.equal((await pos(A)).position, "0");
  const { db } = tmpDb();
  const p1 = planProbe(db, { pairIds: ["CC001", "CC002"], sweep: 1, ref: "226.00", window: 2 });
  db.prepare("UPDATE trades SET status = 'never-settled' WHERE trade_id = ?").run(p1.trade_id);
  const p2 = planProbe(db, { pairIds: ["CC001", "CC002"], sweep: 5, ref: "226.00" });
  assert.deepEqual([p1.maker_id, p2.maker_id], ["CC001", "CC002"]);
});

test("resolution reads only what the referee listed: settled / expired / ambiguous void:settled / repost / query", () => {
  const { db } = tmpDb();
  const t = planProbe(db, { pairIds: ["CC001", "CC002"], sweep: 10, ref: "226.00", window: 6 });
  assert.equal(resolveProbe(db, t, 12).kind, "repost-same");
  assert.equal(resolveProbe(db, t, 17).kind, "query-repost");
  db.prepare("INSERT INTO void_ids (id, n, reason) VALUES (?, 17, 'expired')").run(t.trade_id);
  assert.equal(resolveProbe(db, t, 17).kind, "resolved-never-settled");
  const u = planProbe(db, { pairIds: ["CC003", "CC004"], sweep: 10, ref: "226.00" });
  db.prepare("INSERT INTO void_ids (id, n, reason) VALUES (?, 18, 'settled')").run(u.trade_id);
  assert.equal(resolveProbe(db, u, 18).kind, "ambiguous");
  db.prepare("INSERT INTO settled_ids (id, n) VALUES (?, 11)").run(u.trade_id);
  const r = resolveProbe(db, u, 18);
  assert.equal(r.kind, "resolved-settled");
  assert.match((r as { caveat: string }).caveat, /someone else's copy/);
});
