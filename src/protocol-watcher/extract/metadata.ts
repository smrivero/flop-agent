/**
 * Document metadata for a flop.finance page. Two source shapes seen in the
 * wild: a `<div class="meta"><span>Label<b>Value</b></span>...</div>` block
 * (Yellow Paper, teaser -- carries Version/Status/Updated, and on the teaser
 * also Testnet/Mainnet/"Definitive spec"), or -- on the lighter intro pages
 * that don't have one -- a `<footer>` line shaped "Draft · Updated
 * 2026-08-27". Every `.meta` span is captured (not just the three canonical
 * fields) precisely so page-specific facts like "Testnet: Q4 2026" become a
 * diffable, structured value instead of living only in free prose.
 */

import { NodeType, type HTMLElement } from "node-html-parser";
import type { DocumentMetadata, ExtractionItem } from "../types.js";
import { spacedText } from "../normalize/html.js";
import { collapseWhitespace } from "../normalize/text.js";
import { slugify } from "./domUtils.js";

const FOOTER_LINE_RE = /^(.+?)\s*(?:·|&middot;)\s*Updated\s+(\d{4}-\d{2}-\d{2})/i;

export interface MetadataExtraction {
  metadata: DocumentMetadata;
  items: ExtractionItem[];
}

function labelOf(span: HTMLElement): string | undefined {
  const first = span.childNodes[0];
  if (first && first.nodeType === NodeType.TEXT_NODE) {
    const text = first.text.trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

export function extractHtmlMetadata(root: HTMLElement): MetadataExtraction {
  const items: ExtractionItem[] = [];
  const metadata: DocumentMetadata = {};

  const title = root.querySelector("title")?.text.trim();
  if (title) {
    metadata.name = title;
    items.push({ category: "metadata", itemKey: "name", value: title, status: "ok" });
  }

  const banner = root.querySelector(".draft-banner");
  if (banner) {
    const bannerText = collapseWhitespace(spacedText(banner));
    metadata.draftBannerText = bannerText;
    items.push({ category: "metadata", itemKey: "draft_banner", value: bannerText, status: "ok" });
  }

  const metaDiv = root.querySelector(".meta");
  if (metaDiv) {
    for (const span of metaDiv.querySelectorAll(":scope > span")) {
      const bold = span.querySelector("b");
      const label = labelOf(span);
      if (!bold || !label) continue;
      const value = bold.text.trim();
      const key = slugify(label);
      items.push({ category: "metadata", itemKey: `meta_${key}`, value, status: "ok" });
      if (key === "version") metadata.version = value;
      else if (key === "status") metadata.status = value;
      else if (key === "updated") metadata.updatedAt = value;
    }
  } else {
    const footer = root.querySelector("footer");
    if (footer) {
      for (const span of footer.querySelectorAll("span")) {
        const match = FOOTER_LINE_RE.exec(collapseWhitespace(span.text));
        if (match) {
          metadata.status = match[1].trim();
          metadata.updatedAt = match[2];
        }
      }
    }
  }

  if (metadata.version) items.push({ category: "metadata", itemKey: "version", value: metadata.version, status: "ok" });
  if (metadata.status) items.push({ category: "metadata", itemKey: "status", value: metadata.status, status: "ok" });
  if (metadata.updatedAt) items.push({ category: "metadata", itemKey: "updated_at", value: metadata.updatedAt, status: "ok" });

  return { metadata, items };
}
