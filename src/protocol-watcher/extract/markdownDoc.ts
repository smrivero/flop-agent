/**
 * Lightweight structured extraction for the three raw GitHub Markdown
 * sources (tclk README/SPEC/CHANGELOG). These aren't the Yellow-Paper-style
 * normative spec with parameter/open-item/implementation appendices -- what
 * matters here is (a) the document's own name/version (CHANGELOG.md's most
 * recent Keep-a-Changelog entry), and (b) its section structure, so a
 * reordered/renamed/added/removed heading is a diffable, per-heading change
 * rather than only a whole-document hash flip.
 */

import type { DocumentMetadata, ExtractionItem } from "../types.js";
import type { StructuredMarkdownDocument } from "../normalize/markdown.js";

export interface MarkdownMetadataExtraction {
  metadata: DocumentMetadata;
  items: ExtractionItem[];
}

export function extractMarkdownMetadata(doc: StructuredMarkdownDocument): MarkdownMetadataExtraction {
  const items: ExtractionItem[] = [];
  const metadata: DocumentMetadata = {};

  const title = doc.headings.find((h) => h.level === 1)?.text;
  if (title) {
    metadata.name = title;
    items.push({ category: "metadata", itemKey: "name", value: title, status: "ok" });
  }

  const latestReleased = doc.changelogEntries.find((e) => e.version.toLowerCase() !== "unreleased");
  if (latestReleased) {
    metadata.version = latestReleased.version;
    metadata.updatedAt = latestReleased.date;
    items.push({ category: "metadata", itemKey: "version", value: latestReleased.version, status: "ok" });
    if (latestReleased.date) items.push({ category: "metadata", itemKey: "updated_at", value: latestReleased.date, status: "ok" });
  }

  items.push({ category: "metadata", itemKey: "section_count", value: doc.headings.length, status: "ok" });
  doc.headings.forEach((heading, index) => {
    items.push({ category: "metadata", itemKey: `heading_${index}`, value: heading, status: "ok" });
  });

  // A change here is the deterministic signal classify.ts uses for
  // FLOP_TCLK_RAIL_AVAILABLE -- see its "no rail holds value yet" check.
  const statusSection = doc.sections.find((s) => s.heading.trim().toLowerCase() === "status");
  if (statusSection) {
    items.push({ category: "other", itemKey: "rail_status", value: statusSection.body, status: "ok" });
  }

  return { metadata, items };
}
