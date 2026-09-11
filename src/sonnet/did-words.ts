/**
 * DID-letter word filter -- verbatim port of `validate_word` in
 * vendor/technocore-sonnet/sonnet_validate.py: "Every letter must occur in
 * that contributor's full exact registered DID, including the `did:key:`
 * prefix, compared case-insensitively" (sonnet-game.md "Words, form and
 * acceptance"). Note this means the letters d/i/k/e/y from the literal
 * `did:key:` prefix are ALWAYS available to every participant -- this is not
 * a bug, it matches the official rule exactly.
 *
 * Also builds the per-DID word cache (data/sonnet/agent-a-word-cache.json):
 * every dictionary word this DID is allowed to use, bucketed by syllable
 * count, plus the rhyme heuristic stat from rhyme.ts.
 */

import { DID_PATTERN } from "../identity.js";
import { TOKEN_PATTERN } from "./protocol.js";
import type { Lexicon } from "./cmudict.js";
import type { RhymeIndex } from "./rhyme.js";
import { countPotentialRhymeWords } from "./rhyme.js";

export class DidWordError extends Error {}

/** The set of a-z letters present anywhere in the DID string, lowercased --
 * includes the `did:key:` prefix and the multibase body, exactly as the
 * official rule requires. */
export function didAllowedLetters(did: string): Set<string> {
  const allowed = new Set<string>();
  for (const ch of did.toLowerCase()) {
    if (ch >= "a" && ch <= "z") allowed.add(ch);
  }
  return allowed;
}

/** Validates one token's dictionary membership only (no DID check) --
 * verbatim port of `word_syllables`. Returns its syllable count or throws. */
export function wordSyllables(token: string, lexicon: Lexicon): number {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) {
    throw new DidWordError("word: expected one English word with optional trailing punctuation");
  }
  const word = match[1].toLowerCase();
  const count = lexicon.get(word);
  if (count === undefined) {
    throw new DidWordError(`word: ${JSON.stringify(word)} is not in the frozen dictionary`);
  }
  return count;
}

/**
 * Validates a token against dictionary membership AND the contributor's DID
 * letters -- verbatim port of `validate_word`. Returns the syllable count or
 * throws DidWordError with the same information the official validator
 * reports (missing letters, sorted).
 */
export function validateWordForDid(token: string, verifiedDid: string, lexicon: Lexicon): number {
  const count = wordSyllables(token, lexicon);
  if (!DID_PATTERN.test(verifiedDid)) {
    throw new DidWordError("agent_did: expected the registered Ed25519 did:key");
  }
  const allowed = didAllowedLetters(verifiedDid);
  const letters = new Set<string>();
  for (const ch of token.toLowerCase()) {
    if (ch >= "a" && ch <= "z") letters.add(ch);
  }
  const missing = [...letters].filter((ch) => !allowed.has(ch)).sort();
  if (missing.length > 0) {
    throw new DidWordError(`word: letters absent from contributor DID: ${missing.join("")}`);
  }
  return count;
}

// -- per-DID word cache -------------------------------------------------------

export type SyllableBucket = "1" | "2" | "3" | "4+";

function bucketFor(count: number): SyllableBucket {
  if (count <= 1) return "1";
  if (count === 2) return "2";
  if (count === 3) return "3";
  return "4+";
}

export interface DidWordCache {
  did: string;
  identityPath: string;
  dictionarySha256: string;
  generatedAtUtc: string;
  totalValidWords: number;
  bySyllableCount: Record<SyllableBucket, number>;
  potentialRhymeEndingWords: number;
  wordsBySyllableCount: Record<SyllableBucket, string[]>;
}

export interface BuildDidWordCacheOptions {
  did: string;
  identityPath: string;
  dictionarySha256: string;
  lexicon: Lexicon;
  rhymeIndex: RhymeIndex;
}

/**
 * Scans the entire frozen dictionary once and keeps every word whose letters
 * are all present in the DID (including the `did:key:` prefix). Pure/
 * deterministic for a given (did, lexicon) pair -- safe to regenerate at any
 * time; nothing here is secret.
 */
export function buildDidWordCache(options: BuildDidWordCacheOptions): DidWordCache {
  const { did, identityPath, dictionarySha256, lexicon, rhymeIndex } = options;
  const allowed = didAllowedLetters(did);

  const wordsBySyllableCount: Record<SyllableBucket, string[]> = { "1": [], "2": [], "3": [], "4+": [] };
  const allValidWords: string[] = [];

  for (const [word, count] of lexicon) {
    let ok = true;
    for (const ch of word) {
      if (ch === "'") continue;
      if (!allowed.has(ch)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    wordsBySyllableCount[bucketFor(count)].push(word);
    allValidWords.push(word);
  }

  for (const bucket of Object.keys(wordsBySyllableCount) as SyllableBucket[]) {
    wordsBySyllableCount[bucket].sort();
  }

  return {
    did,
    identityPath,
    dictionarySha256,
    generatedAtUtc: new Date().toISOString(),
    totalValidWords: allValidWords.length,
    bySyllableCount: {
      "1": wordsBySyllableCount["1"].length,
      "2": wordsBySyllableCount["2"].length,
      "3": wordsBySyllableCount["3"].length,
      "4+": wordsBySyllableCount["4+"].length,
    },
    potentialRhymeEndingWords: countPotentialRhymeWords(allValidWords, rhymeIndex),
    wordsBySyllableCount,
  };
}
