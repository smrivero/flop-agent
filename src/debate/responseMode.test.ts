import { test } from "node:test";
import assert from "node:assert/strict";
import { randomResponseMode, responseModeInstruction, type ResponseMode } from "./responseMode.js";

test("randomResponseMode: only ever returns one of the five defined modes", () => {
  const valid = new Set<ResponseMode>(["ONE_LINER", "SHORT", "NORMAL", "DETAILED", "WILDCARD"]);
  for (let i = 0; i < 500; i++) {
    assert.ok(valid.has(randomResponseMode()), `unexpected mode from randomResponseMode()`);
  }
});

test("randomResponseMode: distribution over many samples is roughly 20/30/30/15/5", () => {
  const counts: Record<ResponseMode, number> = { ONE_LINER: 0, SHORT: 0, NORMAL: 0, DETAILED: 0, WILDCARD: 0 };
  const N = 20000;
  for (let i = 0; i < N; i++) counts[randomResponseMode()]++;

  const pct = (mode: ResponseMode) => (counts[mode] / N) * 100;
  // Generous tolerance -- this is a statistical property, not an exact one; the
  // point is to catch a badly wrong weight table, not flake on normal variance.
  assert.ok(Math.abs(pct("ONE_LINER") - 20) < 3, `ONE_LINER ${pct("ONE_LINER")}%`);
  assert.ok(Math.abs(pct("SHORT") - 30) < 3, `SHORT ${pct("SHORT")}%`);
  assert.ok(Math.abs(pct("NORMAL") - 30) < 3, `NORMAL ${pct("NORMAL")}%`);
  assert.ok(Math.abs(pct("DETAILED") - 15) < 3, `DETAILED ${pct("DETAILED")}%`);
  assert.ok(Math.abs(pct("WILDCARD") - 5) < 2, `WILDCARD ${pct("WILDCARD")}%`);
});

test("randomResponseMode: deterministic given an injected random source, and covers boundaries", () => {
  // Cumulative bounds: ONE_LINER [0, .20), SHORT [.20, .50), NORMAL [.50, .80),
  // DETAILED [.80, .95), WILDCARD [.95, 1).
  assert.equal(randomResponseMode(() => 0), "ONE_LINER");
  assert.equal(randomResponseMode(() => 0.19999), "ONE_LINER");
  assert.equal(randomResponseMode(() => 0.2), "SHORT");
  assert.equal(randomResponseMode(() => 0.49999), "SHORT");
  assert.equal(randomResponseMode(() => 0.5), "NORMAL");
  assert.equal(randomResponseMode(() => 0.79999), "NORMAL");
  assert.equal(randomResponseMode(() => 0.8), "DETAILED");
  assert.equal(randomResponseMode(() => 0.94999), "DETAILED");
  // Not exactly 0.95: 0.2+0.3+0.3+0.15 sums to 0.9500000000000001 in IEEE 754,
  // so the literal 0.95 is (correctly) still inside DETAILED's range by that
  // sliver -- immaterial for Math.random() in practice, but this test picks a
  // value unambiguously past the real computed boundary instead of relying on
  // floating-point addition landing on an exact decimal.
  assert.equal(randomResponseMode(() => 0.951), "WILDCARD");
  assert.equal(randomResponseMode(() => 0.99999), "WILDCARD");
});

test("responseModeInstruction: each mode's target range matches the spec", () => {
  assert.match(responseModeInstruction("ONE_LINER", 3500), /RESPONSE MODE: ONE_LINER/);
  assert.match(responseModeInstruction("ONE_LINER", 3500), /40-180 characters/);
  assert.match(responseModeInstruction("SHORT", 3500), /120-350 characters/);
  assert.match(responseModeInstruction("NORMAL", 3500), /250-700 characters/);
  assert.match(responseModeInstruction("DETAILED", 3500), /500-1200 characters/);
});

test("responseModeInstruction: WILDCARD describes freedom, not a fixed target", () => {
  const text = responseModeInstruction("WILDCARD", 3500);
  assert.match(text, /RESPONSE MODE: WILDCARD/);
  assert.match(text, /brutal one-sentence/);
});

test("responseModeInstruction: a mode's range is clamped to a tighter MAX_MESSAGE_CHARS", () => {
  const text = responseModeInstruction("DETAILED", 300); // cap below DETAILED's default 500-1200
  assert.match(text, /approximately \d+-300 characters/);
});

test("responseModeInstruction: min never exceeds max after clamping", () => {
  const text = responseModeInstruction("DETAILED", 50); // cap below even the mode's min
  const match = text.match(/approximately (\d+)-(\d+) characters/);
  assert.ok(match);
  assert.ok(Number(match![1]) <= Number(match![2]));
});
