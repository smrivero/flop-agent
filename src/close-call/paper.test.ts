/**
 * End to end, with the OFFICIAL fold: referee posts -> paper mint -> decide -> settle -> reconcile -> restart.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { toMicro } from "./decimal.js";
import { OfficialFold } from "./fold.js";
import { keyStatusCounts } from "./keys.js";
import { foldConfig, PaperTrader } from "./paper.js";
import type { PricePost } from "./protocol.js";
import { haltSummary } from "./safety.js";
import { contest, RefereeFeed, testConfig, tmpDb, VENDOR } from "./test-helpers.js";
import { sweepTime } from "./contest.js";

const at = (n: number) => sweepTime(contest(), n) - 20_000;   // decide 20 s before the boundary, like the service

const folds: OfficialFold[] = [];
after(() => folds.forEach((f) => f.stop()));

async function trader(db: ReturnType<typeof tmpDb>["db"], env: Record<string, string> = {}) {
  const cfg = testConfig({ CLOSECALL_KEY_COUNT: "10", ...env });
  const main = await OfficialFold.start("python3", VENDOR, foldConfig(contest()));
  const look = await OfficialFold.start("python3", VENDOR, foldConfig(contest()));
  folds.push(main, look);
  const p = new PaperTrader(db, cfg, contest(), main, look, null);
  await p.start();
  return p;
}

const priceOf = (events: { kind: string; post?: unknown }[]) => events.find((e) => e.kind === "price")!.post as PricePost;

test("paper pipeline: no trading before MINT_CONFIRMED; intents, settlement, voids, retries, restart, halt", async () => {
  const { db } = tmpDb();
  const feed = new RefereeFeed(db);
  feed.seed("226.14");
  feed.sweep(1, { close: "226.00", applied: "226.14", owners: 0, prevOwners: 0 });
  const p = await trader(db);
  assert.equal(p.keys.length, 10);
  assert.deepEqual(keyStatusCounts(db), { REGISTER_PENDING: 10 }, "registered (paper) is not minted");

  // Sweep 2: keys are only REGISTER_PENDING -> no intents at all.
  assert.deepEqual(await p.decide(2, true, at(2)), []);
  // The referee posts sweep 2: the paper book mints the keys in the official fold -> MINT_CONFIRMED -> READY.
  await p.settle(2, priceOf(feed.sweep(2, { close: "226.00", applied: "226.00", owners: 5, prevOwners: 0 })));
  assert.deepEqual(keyStatusCounts(db), { READY: 10 });
  const ev = JSON.parse((db.prepare("SELECT mint_evidence FROM keys WHERE id = 'CC001'").get() as { mint_evidence: string }).mint_evidence);
  assert.deepEqual(ev, { source: "paper-fold", sweep: 2, detail: "official fold sweep result lists the DID in minted (paper)" });

  // Sweep 3: split start, two favoured pairs, priced from the referee's close of sweep 2 (no Hyperliquid in this test).
  const i3 = await p.decide(3, true, at(3));
  assert.deepEqual(i3.map((i) => [i.intent.favored, i.wire.maker, i.wire.countersigner]), [["long", p.keys[0].did, p.keys[1].did], ["short", p.keys[2].did, p.keys[3].did]]);
  const rows = db.prepare("SELECT risk_status, risk_detail, maker_signing, message_preview FROM intents WHERE sweep = 3").all() as Record<string, string>[];
  assert.deepEqual(rows.map((r) => r.risk_status), ["OK", "OK"]);
  assert.ok(JSON.parse(rows[0].risk_detail).checks.some((c: { name: string; ok: boolean }) => c.name === "keys_mint_confirmed" && c.ok));
  assert.match(JSON.parse(rows[0].maker_signing).would_sign, /^close-1\|terms\|\{"id":"[0-9a-f]{32}","maker":"did:key:/);
  assert.equal(JSON.parse(rows[0].maker_signing).signature, null, "nothing is ever signed");
  assert.match(rows[0].message_preview, /"maker_sig":"<maker_sig 86 chars>"/);

  // (No Hyperliquid feed here, so the estimator flags the estimate stale and the wide 0.4%/1.2% margins apply.)
  // The real close lands 0.1% above our estimate: both settle.
  await p.settle(3, priceOf(feed.sweep(3, { close: "226.22", applied: "226.00", owners: 15, prevOwners: 5 })));
  const r3 = db.prepare("SELECT outcome, prediction_error_bps, lookahead_outcome FROM intents WHERE sweep = 3 ORDER BY pair_index").all() as Record<string, unknown>[];
  assert.deepEqual(r3.map((r) => r.outcome), ["settled", "settled"]);
  assert.ok(Math.abs((r3[0].prediction_error_bps as number) + 9.73) < 0.1, "estimate 226.00 vs close 226.22");
  assert.equal(r3[0].lookahead_outcome, "settled");
  const act = db.prepare("SELECT id, strategy_role FROM keys WHERE status = 'ACTIVE' ORDER BY id").all() as { id: string; strategy_role: string }[];
  assert.deepEqual(act.map((k) => `${k.id}:${k.strategy_role}`), ["CC001:long*", "CC002:short", "CC003:long", "CC004:short*"]);

  // Sweep 4 closes at 225.30, 0.31% under the low of 226.00: at sweep 5 that is a new low (favoured long).
  feed.post("d-close1-price", { t: "price", n: 3.5, ref: { px: "0", tid: 0, time: "x" }, limits: ["0", "0"], global: "0", file: "x" }); // malformed: ignored
  assert.deepEqual(await p.decide(4, true, at(4)), [], "no trigger at 226.22");
  await p.settle(4, priceOf(feed.sweep(4, { close: "225.30", applied: "226.22", owners: 20, prevOwners: 15 })));
  const i5 = await p.decide(5, true, at(5));
  assert.deepEqual(i5.map((i) => i.intent.trigger), ["new-low"]);
  // ... and the close jumps +1.5%, beyond the 1.2% quantity margin: the all-in buyer is voided for funds.
  await p.settle(5, priceOf(feed.sweep(5, { close: "228.70", applied: "225.30", owners: 25, prevOwners: 20 })));
  const r5 = db.prepare("SELECT outcome, reason FROM intents WHERE sweep = 5").get() as { outcome: string; reason: string };
  assert.deepEqual({ ...r5 }, { outcome: "void", reason: "funds" });
  assert.equal(p.state.retries.length, 1, "the voided pair is queued for a retry");
  const i6 = await p.decide(6, true, at(6));
  // 228.70 is also a new high (>= 226.00 * 1.0025): the retry comes first, then a new pair favouring the short
  assert.deepEqual(i6.map((i) => [i.intent.trigger, i.intent.pairIndex, i.intent.favored]), [["retry", 2, "long"], ["new-high", 3, "short"]]);

  // Restart: a new trader replays every paper sweep through the official fold and reconciles.
  const q = await trader(db);
  assert.deepEqual((await q.fold.accounts(null)).accounts, (await p.fold.accounts(null)).accounts);
  assert.equal(haltSummary(db), null);

  // A divergence between the official fold and the mirror halts the strategy.
  q.ledger.accounts.get(q.keys[0].did)!.cash += 1n;
  assert.equal(await q.reconcileBooks(99, "test"), false);
  assert.match(haltSummary(db)!, /L2 books mismatch/);
  assert.deepEqual(await q.decide(7, true, at(7)), []);
});

test("a stale referee: no new entries under the default policy; REDUCE still trades with wide margins", async () => {
  for (const policy of ["adaptive", "REDUCE"] as const) {
    const { db } = tmpDb();
    const feed = new RefereeFeed(db);
    feed.seed("226.14");
    feed.sweep(1, { close: "225.03", applied: "226.14", owners: 0, prevOwners: 0 });
    const p = await trader(db, { CLOSECALL_STALE_POLICY: policy });
    await p.settle(2, priceOf(feed.sweep(2, { close: "225.03", applied: "225.03", owners: 5, prevOwners: 0, ageS: 5102 })));
    const r = p.referenceFor(5);                       // sweeps 3 and 4 not posted
    assert.equal(r?.source, "stale-carry");
    assert.equal(toMicro(r!.ref), toMicro("225.03"));
    const i = await p.decide(5, true, at(5));
    if (policy === "adaptive") {
      assert.equal(i.length, 0, "HALT_NEW_ENTRIES: the trade would be priced at a close that is ~1.4 h old");
      const t = db.prepare("SELECT decision, detail FROM strategy_triggers WHERE sweep = 5").get() as { decision: string; detail: string };
      assert.equal(t.decision, "no new entries");
      assert.match(t.detail, /age_s 5702 >= 300/);    // 5102 at sweep 2, +300 for each unposted sweep (3, 4)
      assert.equal(p.state.started, false, "the ladder was not consumed: it fires again on fresh data");
    } else {
      assert.equal(i.length, 2);
      const row = db.prepare("SELECT qty_margin, risk_detail FROM intents WHERE sweep = 5 LIMIT 1").get() as { qty_margin: number; risk_detail: string };
      assert.equal(row.qty_margin, 0.012, "REDUCE: wider margins");
      assert.equal(JSON.parse(row.risk_detail).ref_source, "stale-carry");
    }
  }
});
