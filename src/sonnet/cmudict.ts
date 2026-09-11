/**
 * The frozen CMUdict pronunciation dictionary, loaded from the vendored
 * package (vendor/technocore-sonnet/cmudict.dict -- see VENDOR.json /
 * upstream.json for exact provenance). This module is a line-for-line TS port
 * of `read_lexicon` in vendor/technocore-sonnet/sonnet_validate.py: same
 * comment handling, same variant-suffix stripping, same "largest listed
 * syllable count wins" rule, same WORD grammar. Do not "improve" the parsing
 * here without re-checking it against the official Python first -- a
 * divergence would silently accept/reject different words than the real
 * referee's validator.
 *
 * Never depends on a globally-installed CMUdict or a different snapshot --
 * always reads the exact vendored file and verifies its hash against
 * upstream.json before trusting it (see verifyDictionaryHash).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WORD_PATTERN } from "./protocol.js";
import type { SonnetConfig } from "./config.js";

export class CmudictError extends Error {}

/** ARPAbet vowel phone codes (stress digit stripped) -- verbatim port of the
 * Python VOWELS set. Exported for rhyme.ts's separate, explicitly heuristic
 * phoneme parse -- see that module's header for why it doesn't reuse
 * parseLexicon itself. */
export const VOWELS = new Set([
  "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
]);

/** Variant-pronunciation suffix on a headword, e.g. `TEST(2)` -- stripped
 * before the word is used as a lexicon/rhyme key, per the official parser. */
export const VARIANT_SUFFIX = /\(\d+\)$/;

export type Lexicon = ReadonlyMap<string, number>;

/**
 * Charges the largest listed syllable count per word, same as the official
 * validator. Unknown/malformed entries (comment lines, non-word tokens such
 * as bare punctuation entries) are silently skipped, matching read_lexicon.
 */
export function parseLexicon(dictText: string): Lexicon {
  const counts = new Map<string, number>();
  for (const rawLine of dictText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const beforeComment = line.split("#", 1)[0];
    const fields = beforeComment.split(/\s+/).filter((f) => f.length > 0);
    if (fields.length === 0 || fields[0].startsWith(";;;")) continue;

    const word = fields[0].replace(VARIANT_SUFFIX, "").toLowerCase();
    if (!WORD_PATTERN.test(word)) continue;

    let count = 0;
    for (const phone of fields.slice(1)) {
      const stem = phone.slice(0, -1);
      const stress = phone.slice(-1);
      if (VOWELS.has(stem) && (stress === "0" || stress === "1" || stress === "2")) count += 1;
    }
    if (count > 0) {
      const existing = counts.get(word);
      if (existing === undefined || count > existing) counts.set(word, count);
    }
  }
  if (counts.size === 0) {
    throw new CmudictError("dictionary: no usable pronunciations");
  }
  return counts;
}

export interface LoadedDictionary {
  lexicon: Lexicon;
  path: string;
  sha256: string;
}

/**
 * Loads the vendored dictionary and verifies its bytes match the frozen
 * upstream hash recorded in vendor/technocore-sonnet/upstream.json --
 * mirrors the check scripts/check_word.py performs before trusting the file.
 * Throws CmudictError (never silently proceeds) on any mismatch.
 */
export function loadDictionary(config: SonnetConfig): LoadedDictionary {
  const path = resolve(config.vendorRoot, "cmudict.dict");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new CmudictError(
      `no vendored cmudict.dict at ${path}. Expected the frozen package under vendor/technocore-sonnet/ (see VENDOR.json).`,
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const upstreamPath = resolve(config.vendorRoot, "upstream.json");
  let expectedSha256: string | undefined;
  try {
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf8")) as {
      cmudict?: { dictionary?: { sha256?: string } };
    };
    expectedSha256 = upstream.cmudict?.dictionary?.sha256;
  } catch {
    throw new CmudictError(`could not read expected dictionary hash from ${upstreamPath}`);
  }
  if (!expectedSha256) {
    throw new CmudictError(`${upstreamPath} does not record cmudict.dictionary.sha256`);
  }
  if (sha256 !== expectedSha256) {
    throw new CmudictError(
      `${path}: sha256 ${sha256} does not match the frozen upstream hash ${expectedSha256} recorded in ${upstreamPath}. ` +
        "Do not proceed with a dictionary that doesn't match the official snapshot -- re-vendor the package instead.",
    );
  }

  const lexicon = parseLexicon(bytes.toString("utf8"));
  return { lexicon, path, sha256 };
}
