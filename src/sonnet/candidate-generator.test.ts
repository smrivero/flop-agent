import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCandidates } from "./candidate-generator.js";
import type { Lexicon } from "./cmudict.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const LEXICON: Lexicon = new Map([
  ["the", 1],
  ["i", 1],
  ["deeded", 2],
  ["i'd", 1],
  ["wool", 1], // 'w','o','l' are not all in DID -- must be excluded regardless of syllables
  ["astonishment", 4],
]);

test("generateCandidates: excludes words whose letters aren't all in the DID", () => {
  const candidates = generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 10 });
  const words = candidates.map((c) => c.word);
  assert.ok(words.includes("the"));
  assert.ok(!words.includes("wool"));
});

test("generateCandidates: excludes words that would overflow the remaining syllable budget", () => {
  const candidates = generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 1 });
  const words = candidates.map((c) => c.word);
  assert.ok(words.includes("the"));
  assert.ok(!words.includes("deeded")); // 2 syllables > remaining 1
});

test("generateCandidates: a word with count <= remaining is legal even if not an exact match", () => {
  const candidates = generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 5 });
  const words = candidates.map((c) => c.word);
  assert.ok(words.includes("deeded")); // 2 <= 5
});

test("generateCandidates: rejects an out-of-range remainingSyllables", () => {
  assert.throws(() => generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 0 }), RangeError);
  assert.throws(() => generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 11 }), RangeError);
});

test("generateCandidates: tags rhyme matches without filtering non-matches out", () => {
  const rhymeIndex = new Map([
    ["the", "AH"],
    ["i", "AY"],
  ]);
  const candidates = generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 10, rhymeIndex, targetRhymeKey: "AH" });
  const the = candidates.find((c) => c.word === "the");
  const i = candidates.find((c) => c.word === "i");
  assert.equal(the?.rhymesWithTarget, true);
  assert.equal(i?.rhymesWithTarget, false);
});

test("generateCandidates: limit caps the result, preferring rhyme matches first", () => {
  const rhymeIndex = new Map([["deeded", "X"]]);
  const candidates = generateCandidates({ lexicon: LEXICON, did: DID, remainingSyllables: 10, rhymeIndex, targetRhymeKey: "X", limit: 2 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].word, "deeded");
});
