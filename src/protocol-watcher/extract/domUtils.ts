/**
 * Small structural helpers shared by the Appendix A / E / H extractors.
 * Everything here walks the DOM (node-html-parser) directly -- no table or
 * section is ever pulled out of raw HTML with a regex.
 */

import type { HTMLElement } from "node-html-parser";

/** Every element preceding `el` in reading order: its own preceding
 * siblings first (nearest first), then its parent's preceding siblings, and
 * so on up to the document root. Approximate document order, but "nearest
 * preceding element" -- which is all every caller here needs -- is exact. */
function precedingElements(el: HTMLElement): HTMLElement[] {
  const results: HTMLElement[] = [];
  let current: HTMLElement | null = el;
  while (current) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      results.push(sibling);
      sibling = sibling.previousElementSibling;
    }
    current = current.parentNode as HTMLElement | null;
  }
  return results;
}

export interface PrecedingHeading {
  id?: string;
  text: string;
}

/** The nearest heading (h1-h4) that precedes `el` in the document -- used as
 * the "section" an extracted table/item belongs to. */
export function nearestPrecedingHeading(el: HTMLElement): PrecedingHeading | undefined {
  for (const candidate of precedingElements(el)) {
    if (/^h[1-4]$/i.test(candidate.tagName ?? "")) {
      const id = candidate.getAttribute("id");
      return { id: id ?? undefined, text: candidate.text.trim() };
    }
  }
  return undefined;
}

/**
 * A short `<p><strong>Label</strong></p>` group header directly above `el`
 * (Appendix A's "Genesis" / "Emission & Rewards" / ... table group labels) --
 * stops looking as soon as it crosses an actual heading, so a group label
 * from an unrelated, earlier table is never picked up by mistake.
 */
export function nearestPrecedingGroupLabel(el: HTMLElement): string | undefined {
  for (const candidate of precedingElements(el)) {
    if (/^h[1-4]$/i.test(candidate.tagName ?? "")) return undefined;
    if (candidate.tagName === "P") {
      const text = candidate.text.trim();
      const strong = candidate.querySelector("strong");
      if (strong && strong.text.trim() === text && text.length > 0 && text.length < 80) {
        return text;
      }
    }
  }
  return undefined;
}

export function sectionLabel(el: HTMLElement): string | undefined {
  const heading = nearestPrecedingHeading(el);
  const group = nearestPrecedingGroupLabel(el);
  if (heading && group) return `${heading.text} / ${group}`;
  return heading?.text ?? group;
}

/** Generic header-driven row reader: maps each `<td>` to its `<th>` label
 * (lowercased, trimmed) so callers work off column *names*, not fixed
 * indices -- tables in this document family don't all have the same column
 * count (Appendix A's per-group tables, Appendix H's per-subsection tables). */
export function readTableRows(table: HTMLElement): Record<string, HTMLElement>[] {
  const headerCells = table.querySelectorAll("thead th");
  const headers = headerCells.map((th) => th.text.trim().toLowerCase());
  if (headers.length === 0) return [];

  const bodyRows = table.querySelectorAll("tbody tr").length > 0 ? table.querySelectorAll("tbody tr") : table.querySelectorAll("tr").slice(1);

  return bodyRows.map((tr) => {
    const cells = tr.querySelectorAll(":scope > td");
    const record: Record<string, HTMLElement> = {};
    headers.forEach((header, i) => {
      if (cells[i]) record[header] = cells[i];
    });
    return record;
  });
}

/** Text of every `<code>` descendant, joined -- the "code path" half of a
 * mixed cell like `<code>a.md</code>; review #123`. */
export function codeFragments(cell: HTMLElement): string {
  return cell
    .querySelectorAll("code")
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("; ");
}

/** Every `#123`-shaped tracker reference in a cell's text, joined. */
export function trackerReferences(cell: HTMLElement): string {
  const matches = cell.text.match(/#\d+/g) ?? [];
  return [...new Set(matches)].join(", ");
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
