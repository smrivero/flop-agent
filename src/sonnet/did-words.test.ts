import { test } from "node:test";
import assert from "node:assert/strict";
import {
  didAllowedLetters,
  wordSyllables,
  validateWordForDid,
  DidWordError,
} from "./did-words.js";
import type { Lexicon } from "./cmudict.js";

// Same fixture DID/lexicon shape as vendor/technocore-sonnet/tests/test_validator.py,
// so these tests track the official Python test fixtures directly.
const DID_A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const DID_B = "did:key:z6MkereFQqHaUdcF7yVmHvY1rHpAvVjeCggaBVy45hmE8G6C";
const LEXICON: Lexicon = new Map([
  ["the", 1],
  ["i", 1],
  ["deeded", 2],
  ["i'd", 1],
  ["wool", 1],
]);

test("didAllowedLetters includes the did:key: prefix letters, lowercased", () => {
  const allowed = didAllowedLetters("did:key:z6MkAAAA");
  for (const ch of ["d", "i", "k", "e", "y"]) assert.ok(allowed.has(ch), `expected ${ch} to be allowed`);
});

test("validateWordForDid: letter reuse, case-insensitivity, and prefix letters", () => {
  // "THE" uppercase must be treated identically to lowercase.
  assert.equal(validateWordForDid("THE;", DID_A, LEXICON), 1);
  // The shared "did:key:" prefix supplies d/e regardless of the DID's own body.
  assert.equal(validateWordForDid("DeeDeD!", DID_B, LEXICON), 2);
  // Apostrophes never need to appear in the DID.
  assert.equal(validateWordForDid("I'd,", DID_B, LEXICON), 1);
});

test("validateWordForDid: trailing punctuation handling matches the allowed set exactly", () => {
  for (const punct of [",", ".", ";", ":", "!", "?"]) {
    assert.equal(validateWordForDid(`I${punct}`, DID_A, LEXICON), 1, `punctuation ${punct} should be accepted`);
  }
  assert.throws(() => wordSyllables("I--", LEXICON), DidWordError);
  assert.throws(() => wordSyllables("I!!", LEXICON), DidWordError);
});

test("validateWordForDid: rejects a word whose letters are absent from the DID", () => {
  assert.throws(() => validateWordForDid("wool", DID_A, LEXICON), (err: unknown) => {
    assert.ok(err instanceof DidWordError);
    assert.match((err as Error).message, /letters absent from contributor DID/);
    return true;
  });
});

test("validateWordForDid: rejects malformed / non-did:key sender strings", () => {
  for (const did of ["agent-a", DID_A + "#key", DID_A.toUpperCase()]) {
    assert.throws(() => validateWordForDid("I", did, LEXICON), DidWordError);
  }
});

test("wordSyllables: rejects unknown words and non-single-word tokens", () => {
  for (const token of ["notindictionary", "I I", "I\n", "1", "", "І"]) {
    assert.throws(() => wordSyllables(token, LEXICON), DidWordError);
  }
});
