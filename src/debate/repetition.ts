/**
 * Local, no-API-call repetition check: normalized word-trigram Jaccard
 * similarity against an agent's own recent messages. This is a heuristic, not
 * a semantic check -- it catches "structurally the same message again"
 * (same phrasing, same opening, same argument restated), which is exactly the
 * templated-bot pattern this is meant to break up.
 *
 * Whole-message Jaccard alone misses a specific, real failure mode:
 * reusing one long verbatim passage (a whole paragraph, near-identical
 * wording) inside an otherwise different message. Jaccard divides the
 * shared trigrams by the UNION of both messages' trigrams, so enough
 * genuinely new surrounding content dilutes the score below threshold even
 * when a huge chunk was copied outright -- a real production case measured
 * 0.44 (just under the 0.45 default threshold) for two messages sharing a
 * ~130-word paragraph verbatim. `containmentScore` catches this: it divides
 * by the SMALLER message's trigram count instead of the union, so "most of
 * the shorter message's content also appears in the other one" scores high
 * regardless of how much unrelated material surrounds it on either side.
 */

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(words: string[], n: number): Set<string> {
  if (words.length < n) return new Set(words.length > 0 ? [words.join(" ")] : []);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** intersection / min(|a|, |b|) -- "what fraction of the SMALLER set also
 * appears in the other," unlike jaccard's union-normalized "what fraction of
 * everything in either set is shared." A big verbatim chunk embedded in an
 * otherwise-different, longer message still scores high here. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

/** Normalized word-trigram Jaccard similarity between two texts, 0 (nothing in
 * common) to 1 (identical trigram sets). Falls back to whole-word-set overlap
 * for texts too short to form a trigram. */
export function similarity(a: string, b: string, n = 3): number {
  const wordsA = normalizeWords(a);
  const wordsB = normalizeWords(b);
  if (wordsA.length < n || wordsB.length < n) {
    return jaccard(new Set(wordsA), new Set(wordsB));
  }
  return jaccard(ngrams(wordsA, n), ngrams(wordsB, n));
}

/** Normalized word-trigram containment: what fraction of the SMALLER text's
 * trigrams also appear in the other text, 0 to 1. High when one text is
 * substantially a copy embedded in the other, even if the rest of the
 * longer text is entirely new -- see the module doc comment. */
export function containmentScore(a: string, b: string, n = 3): number {
  const wordsA = normalizeWords(a);
  const wordsB = normalizeWords(b);
  if (wordsA.length < n || wordsB.length < n) {
    return containment(new Set(wordsA), new Set(wordsB));
  }
  return containment(ngrams(wordsA, n), ngrams(wordsB, n));
}

export interface RepetitionCheck {
  tooSimilar: boolean;
  /** Highest similarity score found, for logging even when under threshold. */
  maxScore: number;
  matchedIndex?: number;
}

/** Compares `candidate` against each of `recentMessages` (most recent last is
 * fine, order doesn't matter here) and flags it if either the whole-message
 * Jaccard score exceeds `threshold` (same overall message restated) or the
 * containment score exceeds `containmentThreshold` (a large verbatim chunk
 * reused inside an otherwise different message). `containmentThreshold`
 * defaults higher than a typical `threshold` -- containment scores run
 * higher than Jaccard in general, so reusing the SAME cutoff for both would
 * make this far more trigger-happy across the board, not just for genuine
 * copy-paste. */
export function checkRepetition(
  candidate: string,
  recentMessages: string[],
  threshold: number,
  containmentThreshold = 0.55,
): RepetitionCheck {
  let maxScore = 0;
  let matchedIndex: number | undefined;
  for (let i = 0; i < recentMessages.length; i++) {
    const jaccardScore = similarity(candidate, recentMessages[i]);
    const containScore = containmentScore(candidate, recentMessages[i]);
    const score = Math.max(jaccardScore, containScore);
    if (score > maxScore) maxScore = score;
    if ((jaccardScore >= threshold || containScore >= containmentThreshold) && matchedIndex === undefined) matchedIndex = i;
  }
  return { tooSimilar: matchedIndex !== undefined, maxScore, matchedIndex };
}
