/**
 * Mechanical candidate generation: given the current line's remaining
 * syllable budget and our DID, produce every dictionary word we are legally
 * allowed to propose. Purely mechanical -- no semantic/poetic ranking here
 * (that's poetry-planner.ts, not yet implemented, and it may only ever
 * choose from the set this module returns; see validator.ts's re-check).
 *
 * "Lines close automatically at 10 syllables; a word that would overflow the
 * line is rejected" (sonnet-game.md) -- so a word is legal for the current
 * line iff its syllable count is <= the remaining budget, not necessarily
 * exactly equal to it.
 */

import type { Lexicon } from "./cmudict.js";
import { didAllowedLetters } from "./did-words.js";
import type { RhymeIndex } from "./rhyme.js";

export interface Candidate {
  word: string;
  syllables: number;
  /** Set only when a rhymeIndex + targetRhymeKey were supplied -- a
   * heuristic hint for poetry-planner.ts, never a filter applied here. */
  rhymesWithTarget?: boolean;
}

export interface GenerateCandidatesOptions {
  lexicon: Lexicon;
  did: string;
  /** Syllables still available in the line being written, 1-10. */
  remainingSyllables: number;
  /** Optional: tag (not filter) candidates that share a rhyme key with this
   * target -- e.g. the previous line's end-word, when the target scheme
   * calls for a rhyme here. */
  rhymeIndex?: RhymeIndex;
  targetRhymeKey?: string;
  /** Cap on how many candidates to return (e.g. before handing a shortlist
   * to an LLM) -- 0/undefined means no cap. Rhyme-matching candidates (if
   * any) are always kept first when capping. */
  limit?: number;
}

export function generateCandidates(options: GenerateCandidatesOptions): Candidate[] {
  const { lexicon, did, remainingSyllables, rhymeIndex, targetRhymeKey, limit } = options;
  if (!Number.isInteger(remainingSyllables) || remainingSyllables < 1 || remainingSyllables > 10) {
    throw new RangeError(`remainingSyllables must be an integer 1-10, got ${JSON.stringify(remainingSyllables)}`);
  }

  const allowed = didAllowedLetters(did);
  const candidates: Candidate[] = [];

  for (const [word, syllables] of lexicon) {
    if (syllables > remainingSyllables) continue;
    let ok = true;
    for (const ch of word) {
      if (ch === "'") continue;
      if (!allowed.has(ch)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const rhymesWithTarget = rhymeIndex && targetRhymeKey ? rhymeIndex.get(word) === targetRhymeKey : undefined;
    candidates.push(rhymesWithTarget === undefined ? { word, syllables } : { word, syllables, rhymesWithTarget });
  }

  if (!limit || candidates.length <= limit) return candidates;

  candidates.sort((a, b) => Number(b.rhymesWithTarget ?? false) - Number(a.rhymesWithTarget ?? false));
  return candidates.slice(0, limit);
}
