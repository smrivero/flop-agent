import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "../test-helpers.js";
import { MAX_TRIES, strategyK } from "./k-ladder.js";

const cfg = testConfig().strategy;           // defaults: 100 keys, 0.25%
const K = strategyK(cfg);
const input = (sweep: number, estimate: number, pairCount = 50) => ({ sweep, estimate, lockSweep: 2556, pairCount });

test("defaults are the research recommendation", () => {
  assert.deepEqual({ ...cfg }, { keyCount: 100, threshold: 0.0025, priceMargin: 0.001, qtyMargin: 0.003, reserve: 0, untilPolicy: "this-sweep" });
});

test("opening: a split start, one favoured long and one favoured short pair", () => {
  const d = K.decide(K.initial(), input(48, 225));
  assert.deepEqual(d.intents.map((i) => [i.pairIndex, i.favored, i.trigger]), [[0, "long", "open-split-long"], [1, "short", "open-split-short"]]);
  assert.equal(d.state.lo, 225);
  assert.equal(d.state.hi, 225);
});

test("new pairs only on a new extreme at least `threshold` beyond the last used level", () => {
  let s = K.decide(K.initial(), input(1, 200)).state;
  let d = K.decide(s, input(2, 199.6));          // -0.2%: nothing
  assert.equal(d.intents.length, 0);
  d = K.decide(d.state, input(3, 199.5));        // -0.25%: new low, favour the long
  assert.deepEqual(d.intents.map((i) => [i.pairIndex, i.favored, i.trigger]), [[2, "long", "new-low"]]);
  s = d.state;
  d = K.decide(s, input(4, 199.2));              // measured from the NEW low 199.5: -0.15%, nothing
  assert.equal(d.intents.length, 0);
  d = K.decide(d.state, input(5, 200.5));        // +0.25% over the high 200: favour the short
  assert.deepEqual(d.intents.map((i) => [i.pairIndex, i.favored, i.trigger]), [[3, "short", "new-high"]]);
  assert.equal(d.state.triggers, 4);
});

test("pairs run out gracefully and nothing happens after the lock", () => {
  let s = K.decide(K.initial(), input(1, 100, 3)).state;
  let d = K.decide(s, input(2, 99, 3));
  assert.equal(d.intents.length, 1);
  d = K.decide(d.state, input(3, 98, 3));
  assert.equal(d.intents.length, 0);
  assert.match(d.notes.join(), /all 3 pairs used/);
  s = d.state;
  assert.equal(K.decide(s, { ...input(2557, 50, 3) }).intents.length, 0);
});

test("a voided pair is retried (repriced at the next decision) up to MAX_TRIES, then dropped", () => {
  const d = K.decide(K.initial(), input(1, 100));
  let s = K.onResult(d.state, 0, "long", "open-split-long", 0, false);
  let r = K.decide(s, input(2, 100));
  assert.deepEqual(r.intents.map((i) => [i.pairIndex, i.trigger, i.tries]), [[0, "retry", 1]]);
  s = K.onResult(r.state, 0, "long", "retry", 1, false);
  r = K.decide(s, input(3, 100));
  assert.equal(r.intents[0].tries, 2);
  s = K.onResult(r.state, 0, "long", "retry", MAX_TRIES - 1, false);
  assert.equal(K.decide(s, input(4, 100)).intents.length, 0);
});
