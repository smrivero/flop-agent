/**
 * SKIP detection: the model may return exactly "SKIP" (after the claims
 * trailer is split off and the text is trimmed) instead of a message. Checked
 * against the natural-language part only, and case-sensitively -- an agent
 * that means it says exactly "SKIP", not a message that happens to end with
 * the word "skip" in a sentence.
 */
export function isSkip(message: string): boolean {
  return message.trim() === "SKIP";
}
