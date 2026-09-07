import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "./hash.js";

test("hash: is deterministic and content-sensitive", () => {
  assert.equal(sha256Hex("hello"), sha256Hex("hello"));
  assert.notEqual(sha256Hex("hello"), sha256Hex("hello!"));
  assert.equal(sha256Hex("hello").length, 64);
});
