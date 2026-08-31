/**
 * The last step before signing. Technocore signatures cover the exact bytes
 * that get stored, so whatever this returns is exactly what gets signed -- not
 * the model's raw output. Reuses the project's existing `sweepText` (the same
 * single-line sweep the server itself applies) rather than reimplementing it,
 * so this can never drift from what the server actually enforces.
 */

import { sweepText } from "../technocore.js";

export class SanitizeError extends Error {}

export function sanitizeDebateMessage(raw: string, maxChars: number): string {
  const swept = sweepText(raw);
  if (!swept) {
    throw new SanitizeError("model output had nothing visible left after sanitization");
  }
  if (swept.length <= maxChars) return swept;

  // Truncate at the last whitespace before the cap rather than mid-word/mid-URL.
  const truncated = swept.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? truncated.slice(0, lastSpace) : truncated;
  const result = cut.trim();
  if (!result) throw new SanitizeError("nothing left after truncating to MAX_MESSAGE_CHARS");
  return result;
}
