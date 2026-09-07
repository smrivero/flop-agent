/**
 * Turns a structural extraction diff into typed ProtocolChange records:
 * which ProtocolChangeCategory it belongs to, and how severe it is.
 * Classification is rule-based and deterministic -- the same diff always
 * produces the same category/severity, and none of it depends on an LLM
 * (see summary/llm.ts, which only ever *describes* changes already decided
 * here, never decides them).
 *
 * The action_required rules below are the exact list from this feature's own
 * requirements ("Considera action_required cambios como: ..."); anything not
 * matched by one of them defaults to "info" for a new/removed item or
 * "important" for a modified one that touches a value FLOP-relevant enough
 * to have its own category, in that order of preference.
 */

import type { ExtractionDiffEntry } from "./diff.js";
import type { OpenItem, ImplementationItem, ProtocolChange, ProtocolChangeCategory, ProtocolChangeSeverity } from "./types.js";
import { isWatchedOpenItem } from "./extract/watchedOpenItems.js";

export interface ClassifyContext {
  sourceId: string;
  url: string;
  detectedAt: string;
  documentVersionBefore?: string;
  documentVersionAfter?: string;
}

function previewText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function categoryFor(entry: ExtractionDiffEntry): ProtocolChangeCategory {
  const key = entry.itemKey;
  if (entry.category === "agent") return "agent";
  if (entry.category === "validator") return "validator";
  if (entry.category === "verification") return "verification";
  if (entry.category === "implementation") return "implementation";
  if (key === "rail_status") return "tclk";
  if (key.startsWith("meta_testnet") || key.startsWith("meta_mainnet") || key === "testnet" || key === "mainnet") return "testnet";
  if (entry.category === "tokenomics") {
    if (key.startsWith("genesis_") || key.startsWith("airdrop_")) return "airdrop";
    return "tokenomics";
  }
  return "other";
}

function includesKeyword(text: string | undefined, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function combinedText(entry: ExtractionDiffEntry): string {
  return [entry.itemKey, previewText(entry.previousValue), previewText(entry.currentValue)].filter(Boolean).join(" ").toLowerCase();
}

/** Open items go from `[TBD]`/`[RATIFY]`/`[PLANNED]` toward a settled status
 * as the spec ratifies them -- "no longer TBD/RATIFY" is this feature's own
 * deterministic proxy for "ratified", not a judgment call. */
function openItemRatified(before: unknown, after: unknown): boolean {
  const beforeStatus = (before as OpenItem | undefined)?.status;
  const afterStatus = (after as OpenItem | undefined)?.status;
  if (!beforeStatus || !afterStatus) return false;
  const wasOpen = beforeStatus === "TBD" || beforeStatus === "RATIFY";
  const isSettled = afterStatus !== "TBD" && afterStatus !== "RATIFY";
  return wasOpen && isSettled;
}

const IMPLEMENTATION_PROGRESSED_FROM = new Set(["PLANNED", "GAP"]);
const IMPLEMENTATION_PROGRESSED_TO = new Set(["PARTIAL", "LIVE"]);

function implementationProgressed(before: unknown, after: unknown): boolean {
  const beforeStatus = (before as ImplementationItem | undefined)?.status;
  const afterStatus = (after as ImplementationItem | undefined)?.status;
  if (!beforeStatus || !afterStatus) return false;
  return IMPLEMENTATION_PROGRESSED_FROM.has(beforeStatus) && IMPLEMENTATION_PROGRESSED_TO.has(afterStatus);
}

function railBecameAvailable(before: unknown, after: unknown): boolean {
  const beforeText = typeof before === "string" ? before.toLowerCase() : "";
  const afterText = typeof after === "string" ? after.toLowerCase() : "";
  const wasUnavailable = beforeText.includes("no rail holds value") || beforeText.includes("alpha");
  const isNowAvailable = !afterText.includes("no rail holds value") && (afterText.includes("live") || afterText.includes("mainnet"));
  return wasUnavailable && isNowAvailable;
}

function classifySeverity(entry: ExtractionDiffEntry): ProtocolChangeSeverity {
  const text = combinedText(entry);

  if (entry.itemKey === "rail_status" && railBecameAvailable(entry.previousValue, entry.currentValue)) return "action_required";
  if (includesKeyword(text, ["faucet"])) return "action_required";
  if (includesKeyword(text, ["endpoint", "sdk", "inference interface", "inference_interface"]) && entry.changeType !== "removed") return "action_required";
  if (categoryFor(entry) === "testnet" && entry.changeType !== "removed") return "action_required";
  if (entry.itemKey === "airdrop_vesting_duration_blocks" && entry.changeType === "modified") return "action_required";
  if (/_min_stake$/.test(entry.itemKey) && entry.changeType === "modified") return "action_required";
  if (/_unbonding_blocks$/.test(entry.itemKey) && entry.changeType === "modified") return "action_required";
  if (includesKeyword(text, ["testnet to mainnet", "testnet→mainnet", "testnet conversion"])) return "action_required";
  if (entry.category === "open_item") {
    const id = (entry.currentValue as OpenItem | undefined)?.id ?? (entry.previousValue as OpenItem | undefined)?.id ?? entry.itemKey;
    const ratified = openItemRatified(entry.previousValue, entry.currentValue);
    if (ratified && isWatchedOpenItem(id)) return "action_required";
    if (ratified) return "important";
    if (isWatchedOpenItem(id)) return "important";
  }
  if (entry.category === "implementation" && implementationProgressed(entry.previousValue, entry.currentValue)) return "action_required";
  if (entry.category === "agent" && includesKeyword(text, ["ratified", "verified inference spend"])) return "action_required";

  if (entry.changeType === "modified") return "important";
  return "info";
}

export function classifyChange(entry: ExtractionDiffEntry, ctx: ClassifyContext): ProtocolChange {
  const itemId = entry.category === "open_item" ? ((entry.currentValue as OpenItem | undefined)?.id ?? (entry.previousValue as OpenItem | undefined)?.id) : entry.itemKey;

  return {
    sourceId: ctx.sourceId,
    documentVersionBefore: ctx.documentVersionBefore,
    documentVersionAfter: ctx.documentVersionAfter,
    detectedAt: ctx.detectedAt,
    category: categoryFor(entry),
    itemId,
    field: entry.itemKey,
    previousValue: entry.previousValue,
    currentValue: entry.currentValue,
    changeType: entry.changeType,
    severity: classifySeverity(entry),
    evidence: {
      url: ctx.url,
      section: entry.sourceSection,
      beforeText: previewText(entry.previousValue),
      afterText: previewText(entry.currentValue),
    },
  };
}

export function classifyChanges(entries: ExtractionDiffEntry[], ctx: ClassifyContext): ProtocolChange[] {
  return entries.map((entry) => classifyChange(entry, ctx));
}
