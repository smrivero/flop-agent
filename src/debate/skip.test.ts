import { test } from "node:test";
import assert from "node:assert/strict";
import { isSkip } from "./skip.js";

test("isSkip: exact match", () => {
  assert.equal(isSkip("SKIP"), true);
});

test("isSkip: tolerates surrounding whitespace/newlines from the model", () => {
  assert.equal(isSkip("  SKIP\n"), true);
  assert.equal(isSkip("\nSKIP"), true);
});

test("isSkip: case-sensitive -- lowercase or mixed case is a real message, not a skip", () => {
  assert.equal(isSkip("skip"), false);
  assert.equal(isSkip("Skip"), false);
});

test("isSkip: a message that merely contains the word is not a skip", () => {
  assert.equal(isSkip("I'll skip the pleasantries: you're wrong."), false);
  assert.equal(isSkip("SKIP this argument entirely, here's why..."), false);
});

test("isSkip: empty string is not a skip (that's a different failure mode)", () => {
  assert.equal(isSkip(""), false);
  assert.equal(isSkip("   "), false);
});
