/**
 * Appendix E -- Open Specification Items. Each item is one `<p>` shaped as:
 *
 *   <p><strong>E.8 — Title <code>[TBD]</code>.</strong> Description text.
 *   Placeholder: ... Home: §11, §15.2. Blocking: #556.</p>
 *
 * The id/title/status tag live inside the leading <strong> (parsed via the
 * `<code>[TAG]</code>` element, not a raw-HTML regex); the free-form prose
 * after it is parsed with a few anchored regexes over that one paragraph's
 * own plain text -- not a table, so this isn't the "regex table parsing"
 * this feature avoids elsewhere.
 */

import type { HTMLElement } from "node-html-parser";
import type { ExtractionItem, OpenItem } from "../types.js";
import { spacedText } from "../normalize/html.js";
import { collapseWhitespace } from "../normalize/text.js";

const ID_RE = /^(E\.\d+)\s*[—-]\s*(.*)$/s;
const STATUS_TAG_RE = /^\[([A-Z]+)\]$/;

function parseStrong(strong: HTMLElement): { id: string; title: string; status: string } | undefined {
  const strongText = collapseWhitespace(spacedText(strong));
  const match = ID_RE.exec(strongText);
  if (!match) return undefined;
  const id = match[1];

  let status = "UNKNOWN";
  const codes = strong.querySelectorAll("code");
  for (const code of codes) {
    const tagMatch = STATUS_TAG_RE.exec(code.text.trim());
    if (tagMatch) status = tagMatch[1];
  }

  let title = match[2]
    .replace(/\[[A-Z]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  title = title.replace(/\.$/, "").trim();

  return { id, title, status };
}

function extractSection(rest: string): { summary: string; placeholder?: string; sourceSection: string; blockers: string[] } {
  const homeIdx = rest.search(/Home:/);
  const placeholderIdx = rest.search(/Placeholders?:/);
  const firstCutIdx = [homeIdx, placeholderIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const summary = (firstCutIdx === undefined ? rest : rest.slice(0, firstCutIdx)).trim();

  let placeholder: string | undefined;
  const placeholderMatch = /Placeholders?:\s*(.*?)(?=\s*Home:|\s*Blocking:|$)/s.exec(rest);
  if (placeholderMatch) placeholder = placeholderMatch[1].trim() || undefined;

  let sourceSection = "";
  const homeMatch = /Home:\s*(.*?)(?=\s*Blocking:|$)/s.exec(rest);
  if (homeMatch) sourceSection = homeMatch[1].trim().replace(/\.$/, "");

  let blockers: string[] = [];
  const blockingMatch = /Blocking:\s*(.*)$/s.exec(rest);
  if (blockingMatch) {
    blockers = blockingMatch[1]
      .split(/,|\band\b/i)
      .map((s) => s.trim().replace(/\.$/, ""))
      .filter(Boolean);
  }

  return { summary, placeholder, sourceSection, blockers };
}

export function extractOpenItems(root: HTMLElement): OpenItem[] {
  const items: OpenItem[] = [];
  const seen = new Set<string>();

  for (const p of root.querySelectorAll("p")) {
    const strong = p.querySelector("strong");
    if (!strong) continue;
    const parsed = parseStrong(strong);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);

    const fullText = collapseWhitespace(spacedText(p));
    const strongText = collapseWhitespace(spacedText(strong));
    const rest = fullText.startsWith(strongText) ? fullText.slice(strongText.length).trim() : fullText;

    const { summary, placeholder, sourceSection, blockers } = extractSection(rest);

    items.push({
      id: parsed.id,
      title: parsed.title,
      status: parsed.status,
      summary,
      placeholder,
      blockers,
      sourceSection,
    });
  }

  return items;
}

export function openItemsToExtractionItems(items: OpenItem[]): ExtractionItem[] {
  return items.map((item) => ({
    category: "open_item",
    itemKey: item.id,
    value: item,
    sourceSection: item.sourceSection,
    status: "ok",
  }));
}
