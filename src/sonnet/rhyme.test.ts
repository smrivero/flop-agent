import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRhymeIndex, rhymeKeyFromPhones, countPotentialRhymeWords } from "./rhyme.js";

test("rhymeKeyFromPhones: two words ending in the same stressed vowel + coda share a key", () => {
  const cat = rhymeKeyFromPhones(["K", "AE1", "T"]);
  const hat = rhymeKeyFromPhones(["HH", "AE1", "T"]);
  const dog = rhymeKeyFromPhones(["D", "AO1", "G"]);
  assert.equal(cat, hat);
  assert.notEqual(cat, dog);
});

test("rhymeKeyFromPhones: returns undefined when there is no vowel phone at all", () => {
  assert.equal(rhymeKeyFromPhones(["S", "T"]), undefined);
});

test("buildRhymeIndex: skips variant pronunciations (word(2)) and comment lines", () => {
  const text = ";;; comment\nCAT K AE1 T\nCAT(2) K AH0 T # a variant should never win over the base form\nDOG D AO1 G\n";
  const index = buildRhymeIndex(text);
  assert.equal(index.get("cat"), rhymeKeyFromPhones(["K", "AE1", "T"]));
  assert.notEqual(index.get("dog"), index.get("cat"));
});

test("countPotentialRhymeWords: only counts words that share a key with at least one other word in the set", () => {
  const index = buildRhymeIndex("CAT K AE1 T\nHAT HH AE1 T\nDOG D AO1 G\n");
  assert.equal(countPotentialRhymeWords(["cat", "hat", "dog"], index), 2);
  assert.equal(countPotentialRhymeWords(["cat", "dog"], index), 0);
});
