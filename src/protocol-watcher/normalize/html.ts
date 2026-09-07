/**
 * HTML -> two representations, per the "don't use normalized text as the only
 * parser input" requirement:
 *
 *  1. `root` -- a cleaned DOM (node-html-parser) that extractors query
 *     directly for tables, headings, anchors/ids (`E.38`, `#param-...`) and
 *     sections. Structure survives here; extractors never regex-scrape a
 *     table out of raw HTML.
 *  2. `normalizedText` -- plain text of that same cleaned DOM, whitespace-
 *     collapsed, for hashing/diffing/the LLM summary input.
 *
 * Noise removed before either representation is produced: <script>, <style>,
 * <noscript>, <svg> (inline mermaid diagrams), <nav>, <header>, <footer>,
 * <iframe>, <form>, and the page's own `.toc` table-of-contents block (its
 * links duplicate every heading already walked directly, and its presence/
 * absence otherwise causes noise-only diffs).
 */

import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { collapseWhitespace } from "./text.js";

const STRIP_TAGS = ["script", "style", "noscript", "svg", "nav", "header", "footer", "iframe", "form"];

export interface StructuredHtmlDocument {
  root: HTMLElement;
  normalizedText: string;
}

/**
 * node-html-parser's own `.text` concatenates every descendant text node with
 * no separator at all, so two adjacent block elements with no whitespace
 * between their tags in the source (`<td>A</td><td>B</td>`, common in
 * generated/minified HTML) collapse into one merged word ("AB"). Joining
 * every child with a space at each recursion level guarantees a word
 * boundary survives everywhere; collapseWhitespace() cleans up the resulting
 * extra spaces afterwards. Only used for the whole-document normalized text
 * (hashing/diff/LLM input) -- extractors reading one specific cell/heading
 * still use that element's own `.text`, where this merging risk is minimal.
 */
export function spacedText(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text;
  const el = node as HTMLElement;
  return el.childNodes.map((child) => spacedText(child)).join(" ");
}

/**
 * `root` is kept fully intact -- including <footer>/<nav>, which some pages'
 * own metadata (the "Draft · Updated 2026-08-27" footer line) lives inside.
 * Stripping noise before computing `normalizedText` therefore happens on a
 * *separate* parse of the same HTML, not by mutating `root` -- extractors
 * that need `.querySelector("footer")` would otherwise find nothing.
 */
export function parseHtmlDocument(rawHtml: string): StructuredHtmlDocument {
  const parseOptions = { comment: false, blockTextElements: { script: false, style: false, pre: true } } as const;
  const root = parse(rawHtml, parseOptions);

  const forText = parse(rawHtml, parseOptions);
  for (const tag of STRIP_TAGS) {
    for (const el of forText.querySelectorAll(tag)) el.remove();
  }
  for (const el of forText.querySelectorAll(".toc")) el.remove();

  const normalizedText = collapseWhitespace(spacedText(forText));
  return { root, normalizedText };
}
