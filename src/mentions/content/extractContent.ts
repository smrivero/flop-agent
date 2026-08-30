/**
 * Best-effort HTML -> plain text, good enough to hand to an LLM for a relevance
 * check and a one-sentence summary. Deliberately not a full readability
 * implementation (no added dependency for it) -- strips the obviously-irrelevant
 * blocks and all remaining tags, then truncates.
 */

const STRIP_BLOCK_TAGS = ["script", "style", "noscript", "nav", "header", "footer", "svg", "form", "iframe"];

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITY_MAP[entity] ?? match;
  });
}

export function extractContent(html: string, maxChars: number): string {
  let text = html;
  for (const tag of STRIP_BLOCK_TAGS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, maxChars);
}
