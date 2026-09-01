/**
 * The quality gate that sits between "candidate generated" and "sign and
 * publish": generate -> validate -> SEND, REGENERATE ONCE, or SKIP. This
 * module covers the checks that aren't already handled elsewhere (repetition
 * has its own module, reused separately by loop.ts) -- non-empty and
 * well-formed URLs.
 */

const URL_RE = /https?:\/\/\S+/g;

export interface ShapeCheck {
  ok: boolean;
  reasons: string[];
}

/** Every http(s) URL in the text must parse -- catches an obviously truncated
 * or garbled link (a dangling `https://` with nothing after it, mid-word
 * concatenation, stray punctuation swallowed into the URL) without needing a
 * network fetch to confirm the link actually resolves. */
export function findMalformedUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const malformed: string[] = [];
  for (const raw of matches) {
    // Trailing punctuation is normal prose, not part of the URL -- strip a
    // conservative trailing set before validating.
    const candidate = raw.replace(/[),.!?;:'"]+$/, "");
    try {
      new URL(candidate);
    } catch {
      malformed.push(raw);
    }
  }
  return malformed;
}

export function checkShape(text: string): ShapeCheck {
  const reasons: string[] = [];
  if (text.trim() === "") reasons.push("empty");
  const malformed = findMalformedUrls(text);
  if (malformed.length > 0) reasons.push(`malformed_url:${malformed.join(",")}`);
  return { ok: reasons.length === 0, reasons };
}
