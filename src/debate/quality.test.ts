import { test } from "node:test";
import assert from "node:assert/strict";
import { checkShape, findMalformedUrls } from "./quality.js";

test("findMalformedUrls: a well-formed URL, even with trailing prose punctuation, is not flagged", () => {
  assert.deepEqual(findMalformedUrls("Check https://uefa.com/en/uefachampionsleague/history, it's clear."), []);
  assert.deepEqual(findMalformedUrls("Source: https://fcbarcelona.com."), []);
});

test("findMalformedUrls: a dangling scheme with no host is flagged", () => {
  const malformed = findMalformedUrls("According to https://, the numbers are clear.");
  assert.equal(malformed.length, 1);
});

test("findMalformedUrls: no URLs at all -- nothing flagged", () => {
  assert.deepEqual(findMalformedUrls("No links in this one, just an argument."), []);
});

test("checkShape: empty text fails", () => {
  const result = checkShape("   ");
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes("empty"));
});

test("checkShape: normal text with a valid URL passes", () => {
  const result = checkShape("UEFA has Madrid at 15. https://uefa.com/history");
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test("checkShape: a malformed URL fails with a matching reason", () => {
  const result = checkShape("Source: https://.");
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith("malformed_url")));
});
