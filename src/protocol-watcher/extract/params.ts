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
 * considered, not just Appendix A specifically -- nothing here special-cases
 * the "Appendix A" heading text itself. A row only becomes an extracted
 * parameter if its name cell carries a real `<code>`/`#param-` token though
 * (see paramNameFromCell) -- a handful of short prose "summary" tables
 * elsewhere share the exact same "Parameter | Value" header text without
 * being the canonical reference, and their rows are skipped instead of
 * being mistaken for parameters of their own.
 */

import type { HTMLElement } from "node-html-parser";
import type { ExtractionItem } from "../types.js";
import { classifyParamName } from "./paramCategory.js";
import { readTableRows, sectionLabel } from "./domUtils.js";

/**
 * Only a `<a id="param-X">` anchor or a `<code>name</code>` counts as a real
 * machine-readable parameter name -- deliberately NOT a plain-text fallback.
 * The document also has short "Parameter | Value" *summary* tables per
 * section (e.g. §9's "Total genesis supply" row, whose Value cell is a full
 * prose sentence linking several real params together) that happen to share
 * the exact same header text as Appendix A's real tables. Without this
 * restriction those rows were extracted as bogus "parameters" of their own
 * (item key = the prose label, value = the whole sentence) -- confirmed live
 * against flop.finance/intro/yellowpaper/ §9's genesis-supply summary row.
 */
function paramNameFromCell(cell: HTMLElement): string | undefined {
  const anchor = cell.querySelector('a[id^="param-"]');
  if (anchor) {
    const id = anchor.getAttribute("id") ?? "";
    return id.slice("param-".length) || undefined;
  }
  const code = cell.querySelector("code");
  if (code) return code.text.trim() || undefined;
  return undefined;
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
