import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDebateMessage, SanitizeError } from "./sanitize.js";

test("sanitize: every invisible character becomes its own space -- single line, matching the server's sweep exactly", () => {
  const raw = "Line one.\nLine two.\r\nLine three.";
  const result = sanitizeDebateMessage(raw, 3500);
  // \r and \n are each their own invisible character, so \r\n becomes two spaces --
  // this mirrors src/store.py `clean_text` exactly (per-character, not a collapse).
  assert.equal(result, "Line one. Line two.  Line three.");
  assert.ok(!result.includes("\n") && !result.includes("\r"));
});

test("sanitize: text under the cap is returned unchanged (aside from the sweep)", () => {
  const text = "A reasonably short debate message about football history.";
  assert.equal(sanitizeDebateMessage(text, 3500), text);
});

test("sanitize: text over MAX_MESSAGE_CHARS is truncated to the cap", () => {
  const text = "word ".repeat(1000).trim();
  const result = sanitizeDebateMessage(text, 100);
  assert.ok(result.length <= 100);
});

test("sanitize: truncation prefers a word boundary over cutting mid-word", () => {
  const text = "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd";
  const result = sanitizeDebateMessage(text, 25);
  assert.ok(!result.endsWith("cccccc")); // not cut mid "cccccccccc"
  assert.ok(text.startsWith(result));
});

test("sanitize: throws if nothing visible survives the sweep", () => {
  assert.throws(() => sanitizeDebateMessage("​​", 3500), SanitizeError);
});

test("sanitize: never exceeds the configured cap regardless of input length", () => {
  for (const cap of [50, 100, 500, 3500]) {
    const result = sanitizeDebateMessage("x ".repeat(2000), cap);
    assert.ok(result.length <= cap, `cap=${cap} got length=${result.length}`);
  }
});
