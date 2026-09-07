/**
 * Whitespace/line-ending normalization shared by the HTML and Markdown
 * normalizers -- the last step before hashing, so two fetches that differ
 * only in incidental whitespace (CRLF vs LF, trailing spaces, a reformatted
 * paragraph) never register as a content change.
 */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}
