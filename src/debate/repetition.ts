/**
 * Local, no-API-call repetition check: normalized word-trigram Jaccard
 * similarity against an agent's own recent messages. This is a heuristic, not
 * a semantic check -- it catches "structurally the same message again"
 * (same phrasing, same opening, same argument restated), which is exactly the
 * templated-bot pattern this is meant to break up.
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

export interface RepetitionCheck {
  tooSimilar: boolean;
  /** Highest similarity score found, for logging even when under threshold. */
  maxScore: number;
  matchedIndex?: number;
}

/** Compares `candidate` against each of `recentMessages` (same agent, most
 * recent last is fine, order doesn't matter here) and flags it if any exceeds
 * `threshold`. */
export function checkRepetition(candidate: string, recentMessages: string[], threshold: number): RepetitionCheck {
  let maxScore = 0;
  let matchedIndex: number | undefined;
  for (let i = 0; i < recentMessages.length; i++) {
    const score = similarity(candidate, recentMessages[i]);
    if (score > maxScore) maxScore = score;
    if (score >= threshold && matchedIndex === undefined) matchedIndex = i;
  }
  return { tooSimilar: matchedIndex !== undefined, maxScore, matchedIndex };
}
