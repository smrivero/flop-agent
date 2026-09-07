/**
 * Markdown -> two representations, same split as html.ts: headings (and, for
 * a Keep-a-Changelog-style doc, version entries) as structured data for
 * extractors, plus a whitespace-normalized plain-text form for hashing/diff.
 * Line-based parsing only (a heading is a line starting with `#`, a
 * changelog entry is a line starting with `## [`) -- no regex over the whole
 * document, per the "no complex table parsing via regex" rule.
 */

import { collapseWhitespace } from "./text.js";

export interface MarkdownHeading {
  level: number;
  text: string;
}

/** `## [0.1.0] - 2026-09-01` or `## [Unreleased]` (Keep a Changelog 1.0.0). */
export interface ChangelogEntry {
  version: string;
  date?: string;
}

/** A heading plus the raw body lines under it, up to (not including) the next
 * heading at the same or a shallower level -- e.g. tclk's own "## Status"
 * section body, used to notice a rail-availability statement changing. */
export interface MarkdownSection {
  level: number;
  heading: string;
  body: string;
}

export interface StructuredMarkdownDocument {
  headings: MarkdownHeading[];
  changelogEntries: ChangelogEntry[];
  sections: MarkdownSection[];
  normalizedText: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const CHANGELOG_RE = /^##\s*\[([^\]]+)\]\s*(?:-\s*(\d{4}-\d{2}-\d{2}))?/;

export function parseMarkdownDocument(rawMarkdown: string): StructuredMarkdownDocument {
  const headings: MarkdownHeading[] = [];
  const changelogEntries: ChangelogEntry[] = [];
  const sections: MarkdownSection[] = [];

  let current: { level: number; heading: string; bodyLines: string[] } | undefined;
  const flush = () => {
    if (current) sections.push({ level: current.level, heading: current.heading, body: collapseWhitespace(current.bodyLines.join("\n")) });
  };

  for (const line of rawMarkdown.split(/\r\n|\n/)) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      headings.push({ level, text });
      current = { level, heading: text, bodyLines: [] };

      const changelogMatch = CHANGELOG_RE.exec(line);
      if (changelogMatch) changelogEntries.push({ version: changelogMatch[1], date: changelogMatch[2] });
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  flush();

  return { headings, changelogEntries, sections, normalizedText: collapseWhitespace(rawMarkdown) };
}
