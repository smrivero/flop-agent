import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicSummary, formatChangeMessage } from "./deterministic.js";
import type { ProtocolChange, ProtocolSource } from "../types.js";

const SOURCE: ProtocolSource = { id: "yellowpaper", name: "Yellow Paper", url: "https://flop.finance/intro/yellowpaper/", kind: "html-flop", enabled: true };

function baseChange(overrides: Partial<ProtocolChange>): ProtocolChange {
  return {
    sourceId: "yellowpaper",
    detectedAt: "2026-09-10T00:00:00.000Z",
    category: "other",
    changeType: "modified",
    severity: "info",
    evidence: { url: SOURCE.url },
    ...overrides,
  };
}

test("deterministic summary: formats an open-item status line as 'id: before → after'", () => {
  const changes = [
    baseChange({
      category: "other",
      itemId: "E.38",
      field: "E.38",
      severity: "action_required",
      previousValue: { id: "E.38", title: "Committee sampling", status: "TBD", summary: "", blockers: [], sourceSection: "§2.3" },
      currentValue: { id: "E.38", title: "Committee sampling", status: "RATIFIED", summary: "", blockers: [], sourceSection: "§2.3" },
    }),
  ];
  const summary = buildDeterministicSummary(SOURCE, changes, { versionBefore: "0.5.0", versionAfter: "0.5.1" });
  assert.equal(summary.changeLines[0], "E.38: TBD → RATIFIED");
  assert.equal(summary.severity, "action_required");
});

test("deterministic summary: an open item whose status didn't change describes what actually did -- never 'X: TBD → TBD' -- regression for a real production alert", () => {
  const changes = [
    baseChange({
      category: "other",
      itemId: "E.38",
      field: "E.38",
      severity: "important",
      previousValue: { id: "E.38", title: "x", status: "TBD", summary: "old summary", blockers: ["#448", "#848"], sourceSection: "" },
      currentValue: { id: "E.38", title: "x", status: "TBD", summary: "old summary", blockers: ["#448"], sourceSection: "" },
    }),
  ];
  const summary = buildDeterministicSummary(SOURCE, changes, {});
  assert.equal(summary.changeLines[0], "E.38: blockers #448, #848 → #448 (status unchanged: TBD)");
  assert.ok(!summary.changeLines[0].includes("TBD → TBD"));
});

test("deterministic summary: formats a parameter value line as 'field: before → after'", () => {
  const changes = [
    baseChange({
      category: "validator",
      field: "validator_min_stake",
      severity: "action_required",
      previousValue: { value: "50_000 FLOP" },
      currentValue: { value: "75_000 FLOP" },
    }),
  ];
  const summary = buildDeterministicSummary(SOURCE, changes, {});
  assert.equal(summary.changeLines[0], "validator_min_stake: 50_000 FLOP → 75_000 FLOP");
});

test("deterministic summary: formats an implementation status line using the requirement text", () => {
  const changes = [
    baseChange({
      category: "implementation",
      field: "h_2--metering",
      severity: "action_required",
      previousValue: { area: "H.2", requirement: "Metering cert circuit", section: "§3", status: "PLANNED" },
      currentValue: { area: "H.2", requirement: "Metering cert circuit", section: "§3", status: "LIVE" },
    }),
  ];
  const summary = buildDeterministicSummary(SOURCE, changes, {});
  assert.equal(summary.changeLines[0], "Metering cert circuit: PLANNED → LIVE");
});

test("deterministic summary: never invents an Impact line for info-only changes", () => {
  const changes = [baseChange({ field: "draft_banner", severity: "info", previousValue: "a", currentValue: "b" })];
  const summary = buildDeterministicSummary(SOURCE, changes, {});
  assert.equal(summary.impact, undefined);
});

test("deterministic summary: uses one fixed, rule-tied Impact sentence for a validator action_required change", () => {
  const changes = [baseChange({ category: "validator", field: "validator_min_stake", severity: "action_required", previousValue: { value: "1" }, currentValue: { value: "2" } })];
  const summary = buildDeterministicSummary(SOURCE, changes, {});
  assert.match(summary.impact!, /Validator stake\/unbonding requirements changed/);
});

test("formatChangeMessage: matches the requested Telegram template shape", () => {
  const changes = [
    baseChange({
      category: "other",
      itemId: "E.38",
      field: "E.38",
      severity: "action_required",
      previousValue: { id: "E.38", title: "x", status: "TBD", summary: "", blockers: [], sourceSection: "" },
      currentValue: { id: "E.38", title: "x", status: "RATIFIED", summary: "", blockers: [], sourceSection: "" },
    }),
  ];
  const summary = buildDeterministicSummary(SOURCE, changes, { versionBefore: "0.5.0", versionAfter: "0.5.1", updatedBefore: "2026-09-05", updatedAfter: "2026-09-10" });
  const message = formatChangeMessage(summary);
  assert.match(message, /^FLOP Protocol Update\n\nSource: Yellow Paper\nVersion: 0\.5\.0 → 0\.5\.1\nUpdated: 2026-09-05 → 2026-09-10\nSeverity: ACTION REQUIRED\n\nChanges:\n• E\.38: TBD → RATIFIED/);
  assert.match(message, /Source:\nhttps:\/\/flop\.finance\/intro\/yellowpaper\/$/);
});
