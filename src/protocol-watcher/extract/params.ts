/**
 * Appendix A -- Parameter Reference: the Yellow Paper's own single
 * authoritative, generated table of every named protocol constant
 * (`genesis_supply`, `validator_min_stake`, `agent_share_ppt`, ...). Covers
 * tokenomics, airdrop, agent, validator and verification parameters alike --
 * genuinely the best structured source in the document, so this one
 * generic, header-driven table reader (readTableRows) is what backs most of
 * "tokenomics / agent / validator / verification parameters" instead of a
 * hand-written extractor per human-language field name.
 *
 * Every row across every "Parameter | Value | ..." table in the document is
 * captured, not just Appendix A specifically -- a future page that adds a
 * similarly-shaped table elsewhere is picked up automatically, and nothing
 * here special-cases the "Appendix A" heading text itself.
 */

import type { HTMLElement } from "node-html-parser";
import type { ExtractionItem } from "../types.js";
import { classifyParamName } from "./paramCategory.js";
import { readTableRows, sectionLabel } from "./domUtils.js";

function paramNameFromCell(cell: HTMLElement): string | undefined {
  const anchor = cell.querySelector('a[id^="param-"]');
  if (anchor) {
    const id = anchor.getAttribute("id") ?? "";
    return id.slice("param-".length) || undefined;
  }
  const code = cell.querySelector("code");
  if (code) return code.text.trim() || undefined;
  const text = cell.text.trim();
  return text.length > 0 ? text : undefined;
}

function isParameterTable(table: HTMLElement): boolean {
  const firstHeader = table.querySelector("thead th");
  return (firstHeader?.text.trim().toLowerCase() ?? "") === "parameter";
}

export function extractParameterItems(root: HTMLElement): ExtractionItem[] {
  const items: ExtractionItem[] = [];
  const seen = new Set<string>();

  for (const table of root.querySelectorAll("table")) {
    if (!isParameterTable(table)) continue;

    const rows = readTableRows(table);
    const section = sectionLabel(table.parentNode?.tagName === "DIV" ? (table.parentNode as HTMLElement) : table);

    for (const row of rows) {
      const nameCell = row["parameter"];
      if (!nameCell) continue;
      const name = paramNameFromCell(nameCell);
      if (!name) continue;
      if (seen.has(name)) continue; // a duplicate name within one snapshot: keep the first, deterministic
      seen.add(name);

      const value: Record<string, string> = {};
      if (row["value"]) value.value = row["value"].text.trim();
      if (row["§"]) value.section = row["§"].text.trim();
      if (row["decision"]) value.decision = row["decision"].text.trim();
      if (row["description"]) value.description = row["description"].text.trim();

      items.push({
        category: classifyParamName(name),
        itemKey: name,
        value,
        sourceSection: section,
        status: "ok",
      });
    }
  }

  return items;
}
