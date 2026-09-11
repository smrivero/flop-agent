/**
 * Rhyme is a LITERARY target in this contest, not a mechanical eligibility
 * rule: vendor/technocore-sonnet/sonnet-game.md is explicit that "Iambic
 * pentameter and rhyme are literary targets assessed by the judges... they do
 * not by themselves disqualify an otherwise eligible entry", and the package
 * ships no rhyme validator (only `validate_word` / `validate_poem`, which
 * check letters, dictionary membership and syllable counts). So this module
 * is a local heuristic only -- never treated as a protocol rule, never a hard
 * gate in validator.ts (not yet implemented) the way DID-letter/dictionary/
 * syllable checks are.
 *
 * Heuristic: the "rhyme key" of a word is its phoneme tail from the last
 * primary-stressed vowel (falling back to the last vowel of any stress) to
 * the end of its first-listed CMUdict pronunciation, stress digits stripped.
 * Two words that share a rhyme key are considered "potential rhymes" -- nothing
 * more rigorous than that, and never used to accept/reject a word.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VARIANT_SUFFIX, VOWELS } from "./cmudict.js";
import { WORD_PATTERN } from "./protocol.js";
import type { SonnetConfig } from "./config.js";

export type RhymeIndex = ReadonlyMap<string, string>;

/**
 * Parses only the FIRST listed (base, non-variant) pronunciation per word from
 * the vendored dictionary text -- deliberately a separate, independent parse
 * from cmudict.ts's parseLexicon (which returns syllable counts only and is a
 * strict port of the official mandatory validator). Mixing the two would blur
 * "what the referee enforces" with "what this project merely guesses at".
 */
export function buildRhymeIndex(dictText: string): RhymeIndex {
  const index = new Map<string, string>();
  for (const rawLine of dictText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const beforeComment = line.split("#", 1)[0];
    const fields = beforeComment.split(/\s+/).filter((f) => f.length > 0);
    if (fields.length === 0 || fields[0].startsWith(";;;")) continue;
    if (VARIANT_SUFFIX.test(fields[0])) continue; // only the base pronunciation

    const word = fields[0].toLowerCase();
    if (!WORD_PATTERN.test(word) || index.has(word)) continue;

    const key = rhymeKeyFromPhones(fields.slice(1));
    if (key) index.set(word, key);
  }
  return index;
}

function stripStress(phone: string): string {
  const stress = phone.slice(-1);
  return stress === "0" || stress === "1" || stress === "2" ? phone.slice(0, -1) : phone;
}

function isVowel(phone: string): boolean {
  const stem = phone.slice(0, -1);
  const stress = phone.slice(-1);
  return VOWELS.has(stem) && (stress === "0" || stress === "1" || stress === "2");
}

function lastIndexWhere(phones: string[], predicate: (phone: string) => boolean): number {
  for (let i = phones.length - 1; i >= 0; i--) {
    if (predicate(phones[i])) return i;
  }
  return -1;
}

export function rhymeKeyFromPhones(phones: string[]): string | undefined {
  let idx = lastIndexWhere(phones, (p) => isVowel(p) && p.endsWith("1"));
  if (idx === -1) idx = lastIndexWhere(phones, isVowel);
  if (idx === -1) return undefined;
  return phones
    .slice(idx)
    .map(stripStress)
    .join("-");
}

/** Loads the vendored dictionary text and builds the rhyme index -- a thin
 * convenience wrapper so callers don't need to know the vendor file layout. */
export function loadRhymeIndex(config: SonnetConfig): RhymeIndex {
  const path = resolve(config.vendorRoot, "cmudict.dict");
  const text = readFileSync(path, "utf8");
  return buildRhymeIndex(text);
}

/** Among `words`, counts how many share their rhyme key with at least one
 * other word in the same set -- the "potential rhyme-ending words" stat.
 * Purely descriptive; never used to accept/reject a candidate line ending. */
export function countPotentialRhymeWords(words: Iterable<string>, index: RhymeIndex): number {
  const keys = new Map<string, number>();
  const wordKeys = new Map<string, string>();
  for (const word of words) {
    const key = index.get(word);
    if (!key) continue;
    wordKeys.set(word, key);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  let count = 0;
  for (const key of wordKeys.values()) {
    if ((keys.get(key) ?? 0) > 1) count += 1;
  }
  return count;
}
