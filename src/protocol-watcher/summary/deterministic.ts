/**
 * Deterministic, no-LLM summary of one source's changes -- this is what
 * actually decides content; summary/llm.ts (optional) only ever rewords the
 * same structured facts, and this module is also the guaranteed fallback
 * when the LLM is disabled or fails (see run.ts / notify). Per this
 * feature's own rule, this path never invents a consequence -- "Impact" is
 * either omitted or one fixed, rule-tied sentence, never free text.
 */

import type { OpenItem, ImplementationItem, ProtocolChange, ProtocolChangeSeverity, ProtocolSource } from "../types.js";

export interface ChangeSummary {
  sourceId: string;
  sourceName: string;
  url: string;
  versionBefore?: string;
  versionAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
  severity: ProtocolChangeSeverity;
  changeLines: string[];
  impact?: string;
}

const SEVERITY_RANK: Record<ProtocolChangeSeverity, number> = { info: 0, important: 1, action_required: 2 };

function maxSeverity(changes: ProtocolChange[]): ProtocolChangeSeverity {
  return changes.reduce<ProtocolChangeSeverity>((max, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[max] ? c.severity : max), "info");
}

function isOpenItem(value: unknown): value is OpenItem {
  return typeof value === "object" && value !== null && "status" in value && "title" in value && "blockers" in value;
}

function isImplementationItem(value: unknown): value is ImplementationItem {
  return typeof value === "object" && value !== null && "requirement" in value && "area" in value;
}

function isParamValue(value: unknown): value is { value?: string } {
  return typeof value === "object" && value !== null && "value" in value;
}

/** Which OpenItem field actually differs, when the status itself didn't --
 * e.g. a reworded summary or an updated blockers list. Without this, a
 * status-unchanged-but-content-changed diff rendered as the confusing
 * "E.38: TBD → TBD" (real example: a live production alert where only the
 * blockers list had changed). Checked in a fixed, deterministic order. */
function describeUnchangedStatusOpenItem(before: OpenItem, after: OpenItem): string {
  if (before.title !== after.title) return `title updated (status unchanged: ${after.status})`;
  if (JSON.stringify(before.blockers) !== JSON.stringify(after.blockers)) {
    return `blockers ${before.blockers.join(", ") || "(none)"} → ${after.blockers.join(", ") || "(none)"} (status unchanged: ${after.status})`;
  }
  if (before.placeholder !== after.placeholder) return `placeholder text updated (status unchanged: ${after.status})`;
  if (before.summary !== after.summary) return `summary text updated (status unchanged: ${after.status})`;
  return `content updated (status unchanged: ${after.status})`;
}

export function formatChangeLine(change: ProtocolChange): string {
  const { previousValue, currentValue, changeType, field, itemId } = change;

  if (isOpenItem(previousValue) || isOpenItem(currentValue)) {
    if (isOpenItem(previousValue) && isOpenItem(currentValue) && previousValue.status === currentValue.status) {
      return `${itemId}: ${describeUnchangedStatusOpenItem(previousValue, currentValue)}`;
    }
    const before = isOpenItem(previousValue) ? previousValue.status : "(new)";
    const after = isOpenItem(currentValue) ? currentValue.status : "(removed)";
    return `${itemId}: ${before} → ${after}`;
  }

  if (isImplementationItem(previousValue) || isImplementationItem(currentValue)) {
    const requirement = (isImplementationItem(currentValue) ? currentValue.requirement : (previousValue as ImplementationItem | undefined)?.requirement) ?? field;
    const before = isImplementationItem(previousValue) ? previousValue.status : "(new)";
    const after = isImplementationItem(currentValue) ? currentValue.status : "(removed)";
    return `${requirement}: ${before} → ${after}`;
  }

  if (isParamValue(previousValue) || isParamValue(currentValue)) {
    const before = isParamValue(previousValue) ? (previousValue.value ?? "(unset)") : "(new)";
    const after = isParamValue(currentValue) ? (currentValue.value ?? "(unset)") : "(removed)";
    return `${field}: ${before} → ${after}`;
  }

  if (changeType === "added") return `${field}: added (${JSON.stringify(currentValue)})`;
  if (changeType === "removed") return `${field}: removed (was ${JSON.stringify(previousValue)})`;
  return `${field}: ${JSON.stringify(previousValue)} → ${JSON.stringify(currentValue)}`;
}

/** One fixed sentence per known action_required trigger -- never freeform,
 * so this never crosses into "inventing a consequence". Omitted entirely
 * when nothing here recognizes the change shape. */
function fixedImpactNote(changes: ProtocolChange[]): string | undefined {
  const notes: string[] = [];
  if (changes.some((c) => c.category === "tclk" && c.severity === "action_required")) {
    notes.push("A real tclk settlement rail may now be available -- review before relying on PaperRail-only flows.");
  }
  if (changes.some((c) => c.category === "validator" && c.severity === "action_required")) {
    notes.push("Validator stake/unbonding requirements changed -- review any validator-facing configuration.");
  }
  if (changes.some((c) => c.category === "testnet" && c.severity === "action_required")) {
    notes.push("Testnet timing or endpoints changed -- review testnet-dependent plans.");
  }
  if (changes.some((c) => c.category === "agent" && c.severity === "action_required")) {
    notes.push("Agent scoring/inference rules changed -- review agent-facing logic.");
  }
  if (notes.length === 0 && changes.some((c) => c.severity === "action_required")) {
    notes.push("Review the changes below and update dependent flows if needed.");
  }
  return notes.length > 0 ? notes.join(" ") : undefined;
}

export interface SummaryMeta {
  versionBefore?: string;
  versionAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
}

export function buildDeterministicSummary(source: ProtocolSource, changes: ProtocolChange[], meta: SummaryMeta): ChangeSummary {
  return {
    sourceId: source.id,
    sourceName: source.name,
    url: source.url,
    versionBefore: meta.versionBefore,
    versionAfter: meta.versionAfter,
    updatedBefore: meta.updatedBefore,
    updatedAfter: meta.updatedAfter,
    severity: maxSeverity(changes),
    changeLines: changes.map(formatChangeLine),
    impact: fixedImpactNote(changes),
  };
}

const SEVERITY_LABEL: Record<ProtocolChangeSeverity, string> = { info: "INFO", important: "IMPORTANT", action_required: "ACTION REQUIRED" };

/** The exact template shape requested for Telegram (also reused as the
 * human-readable body for `protocol:diff`). */
export function formatChangeMessage(summary: ChangeSummary): string {
  const lines: string[] = ["FLOP Protocol Update", ""];
  lines.push(`Source: ${summary.sourceName}`);
  if (summary.versionBefore || summary.versionAfter) {
    lines.push(`Version: ${summary.versionBefore ?? "(unknown)"} → ${summary.versionAfter ?? "(unknown)"}`);
  }
  if (summary.updatedBefore || summary.updatedAfter) {
    lines.push(`Updated: ${summary.updatedBefore ?? "(unknown)"} → ${summary.updatedAfter ?? "(unknown)"}`);
  }
  lines.push(`Severity: ${SEVERITY_LABEL[summary.severity]}`);
  lines.push("", "Changes:");
  for (const line of summary.changeLines) lines.push(`• ${line}`);
  if (summary.impact) lines.push("", "Impact:", summary.impact);
  lines.push("", "Source:", summary.url);
  return lines.join("\n");
}
