import { test } from "node:test";
import assert from "node:assert/strict";
import { similarity, checkRepetition } from "./repetition.js";

test("similarity: identical text scores 1", () => {
  const text = "Madrid has fifteen European Cups and that settles nothing about football philosophy.";
  assert.equal(similarity(text, text), 1);
});

test("similarity: completely unrelated text scores near 0", () => {
  const a = "Madrid has fifteen European Cups and that settles nothing about football philosophy.";
  const b = "Gold has been used as a store of value for thousands of years across civilizations.";
  assert.ok(similarity(a, b) < 0.15);
});

test("similarity: is case-insensitive and ignores punctuation", () => {
  const a = "Come on, that's a garbage argument!";
  const b = "come on that s a garbage argument";
  assert.ok(similarity(a, b) > 0.8);
});

test("similarity: a paraphrase of the same argument scores meaningfully lower than a near-duplicate", () => {
  const original = "15 Champions, mate. You can't even get the number right.";
  const nearDuplicate = "15 Champions, mate. You can't even get the number correct.";
  const paraphrase = "Madrid's European Cup tally alone makes your point collapse instantly.";
  assert.ok(similarity(original, nearDuplicate) > similarity(original, paraphrase));
});

test("checkRepetition: flags a candidate that's essentially the same message again", () => {
  const recent = [
    "Oh, how adorable. Your move.",
    "Ready to admit Madrid just wins more, historically?",
  ];
  const candidate = "Ready to admit Madrid just wins more, historically?";
  const result = checkRepetition(candidate, recent, 0.45);
  assert.equal(result.tooSimilar, true);
  assert.equal(result.matchedIndex, 1);
});

test("checkRepetition: does not flag a genuinely new message", () => {
  const recent = [
    "Champions League count means nothing without context.",
    "Guardiola's treble changed football tactically.",
  ];
  const candidate = "That's bullshit. Go check the actual transfer fees Madrid paid last summer.";
  const result = checkRepetition(candidate, recent, 0.45);
  assert.equal(result.tooSimilar, false);
});

test("checkRepetition: empty recent-message list never flags anything", () => {
  const result = checkRepetition("Anything at all.", [], 0.45);
  assert.equal(result.tooSimilar, false);
  assert.equal(result.maxScore, 0);
});

test("checkRepetition: threshold is configurable -- a lower threshold catches looser similarity", () => {
  // similarity() for this pair is ~0.154 (measured) -- loosely related phrasing,
  // not a near-duplicate.
  const recent = ["Champions League count means nothing without proper context here."];
  const candidate = "Champions League count really means nothing without the proper context.";
  const looseThreshold = checkRepetition(candidate, recent, 0.1);
  const strictThreshold = checkRepetition(candidate, recent, 0.5);
  assert.equal(looseThreshold.tooSimilar, true);
  assert.equal(strictThreshold.tooSimilar, false);
});

test("checkRepetition: reports the highest similarity score even when under threshold", () => {
  const recent = ["Completely unrelated sentence about gold reserves and central banks."];
  const candidate = "Bitcoin has a fixed supply of twenty-one million coins.";
  const result = checkRepetition(candidate, recent, 0.45);
  assert.equal(result.tooSimilar, false);
  assert.ok(result.maxScore >= 0 && result.maxScore < 0.45);
});
