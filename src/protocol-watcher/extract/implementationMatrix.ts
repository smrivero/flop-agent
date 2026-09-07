/**
 * Appendix H -- Conformance & Implementation-Status Matrix: one table per
 * subsection ("H.1 Core protocol", "H.2 Verification (§3)", ...), columns
 * "Requirement / mechanism", optionally "§", "Status", "Code path · tracker".
 * Tables are told apart from Appendix A's parameter tables purely by header
 * shape (first header starts with "requirement" and a "status" column
 * exists) -- not by section id or heading text, so this keeps working even
 * if Appendix H's own heading ids/wording change.
 */

import type { HTMLElement } from "node-html-parser";
import type { ExtractionItem, ImplementationItem, ImplementationStatus } from "../types.js";
import { codeFragments, nearestPrecedingHeading, readTableRows, slugify, trackerReferences } from "./domUtils.js";

const KNOWN_STATUSES: ImplementationStatus[] = ["LIVE", "PARTIAL", "PLANNED", "GAP", "OOS"];

function parseStatus(cellText: string): ImplementationStatus {
  const trimmed = cellText.trim();
  for (const known of KNOWN_STATUSES) {
    if (trimmed.startsWith(known)) return known;
  }
  return "UNKNOWN";
}

function findHeaderKey(row: Record<string, HTMLElement>, startsWith: string): string | undefined {
  return Object.keys(row).find((k) => k.startsWith(startsWith));
}

/** A §-reference fallback for tables with no "§" column of their own, e.g.
 * "H.2 Verification (§3)" implies every row in that table is §3 unless a row
 * overrides it. */
function sectionFromHeadingText(headingText: string): string {
  const match = /\(§([^)]+)\)/.exec(headingText);
  return match ? `§${match[1]}` : "";
}

function isImplementationMatrixTable(table: HTMLElement): boolean {
  const firstHeader = table.querySelector("thead th")?.text.trim().toLowerCase() ?? "";
  if (!firstHeader.startsWith("requirement")) return false;
  const headers = table.querySelectorAll("thead th").map((th) => th.text.trim().toLowerCase());
  return headers.some((h) => h === "status");
}

export function extractImplementationItems(root: HTMLElement): ImplementationItem[] {
  const items: ImplementationItem[] = [];

  for (const table of root.querySelectorAll("table")) {
    if (!isImplementationMatrixTable(table)) continue;

    const heading = nearestPrecedingHeading(table);
    const area = heading?.text ?? "Unknown area";
    const headingFallbackSection = sectionFromHeadingText(area);

    for (const row of readTableRows(table)) {
      const requirementKey = findHeaderKey(row, "requirement");
      const statusKey = "status";
      if (!requirementKey || !row[statusKey]) continue;

      const requirement = row[requirementKey].text.trim();
      const statusCell = row[statusKey];
      const section = row["§"]?.text.trim() || headingFallbackSection;

      const codePathKey = findHeaderKey(row, "code path");
      const codePath = codePathKey ? codeFragments(row[codePathKey]) || undefined : undefined;
      const tracker = codePathKey ? trackerReferences(row[codePathKey]) || undefined : undefined;

      items.push({
        area,
        requirement,
        section,
        status: parseStatus(statusCell.text),
        codePath,
        tracker,
      });
    }
  }

  return items;
}

export function implementationItemKey(item: ImplementationItem): string {
  return `${slugify(item.area)}--${slugify(item.requirement)}`;
}

export function implementationItemsToExtractionItems(items: ImplementationItem[]): ExtractionItem[] {
  return items.map((item) => ({
    category: "implementation",
    itemKey: implementationItemKey(item),
    value: item,
    sourceSection: item.area,
    status: "ok",
  }));
}
