/**
 * Extraction dispatcher: picks the right extractor set by source kind and
 * never throws -- a single appendix/table missing or malformed becomes a
 * warning (and, for that one item, an ExtractionItem with status "failed"),
 * not a run-ending exception. One source's extraction trouble must never
 * stop the others (see run.ts).
 */

import type { HTMLElement } from "node-html-parser";
import type { StructuredMarkdownDocument } from "../normalize/markdown.js";
import type { DocumentMetadata, ExtractionItem, SourceKind } from "../types.js";
import { extractHtmlMetadata } from "./metadata.js";
import { extractMarkdownMetadata } from "./markdownDoc.js";
import { extractParameterItems } from "./params.js";
import { extractOpenItems, openItemsToExtractionItems } from "./openItems.js";
import { extractImplementationItems, implementationItemsToExtractionItems } from "./implementationMatrix.js";

export interface ExtractionOutcome {
  metadata: DocumentMetadata;
  items: ExtractionItem[];
  warnings: string[];
}

function safely(label: string, warnings: string[], fn: () => ExtractionItem[]): ExtractionItem[] {
  try {
    return fn();
  } catch (err) {
    warnings.push(`${label} extraction failed: ${(err as Error).message}`);
    return [];
  }
}

export function extractHtmlFlopDocument(root: HTMLElement): ExtractionOutcome {
  const warnings: string[] = [];
  const { metadata, items: metadataItems } = extractHtmlMetadata(root);

  const paramItems = safely("Appendix A parameters", warnings, () => extractParameterItems(root));
  const openItems = safely("Appendix E open items", warnings, () => openItemsToExtractionItems(extractOpenItems(root)));
  const implementationItems = safely("Appendix H implementation matrix", warnings, () =>
    implementationItemsToExtractionItems(extractImplementationItems(root)),
  );

  if (paramItems.length === 0) warnings.push("no Appendix A-style parameter table found on this page");
  if (openItems.length === 0) warnings.push("no Appendix E-style open items found on this page");
  if (implementationItems.length === 0) warnings.push("no Appendix H-style implementation matrix found on this page");

  return {
    metadata,
    items: [...metadataItems, ...paramItems, ...openItems, ...implementationItems],
    warnings,
  };
}

export function extractMarkdownTclkDocument(doc: StructuredMarkdownDocument): ExtractionOutcome {
  const { metadata, items } = extractMarkdownMetadata(doc);
  return { metadata, items, warnings: [] };
}

export function extractByKind(kind: SourceKind, parsed: { root?: HTMLElement; markdown?: StructuredMarkdownDocument }): ExtractionOutcome {
  if (kind === "html-flop") {
    if (!parsed.root) throw new Error("extractByKind: html-flop requires a parsed root");
    return extractHtmlFlopDocument(parsed.root);
  }
  if (!parsed.markdown) throw new Error("extractByKind: markdown-tclk requires a parsed markdown document");
  return extractMarkdownTclkDocument(parsed.markdown);
}
