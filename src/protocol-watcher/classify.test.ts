import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "./normalize/html.js";
import { parseMarkdownDocument } from "./normalize/markdown.js";
import { extractHtmlFlopDocument, extractMarkdownTclkDocument } from "./extract/index.js";
import { diffExtractions, toSnapshotEntries } from "./diff.js";
import { classifyChanges, classifyChange } from "./classify.js";
import type { ExtractionDiffEntry } from "./diff.js";

function extractFixture(name: string) {
  const html = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
  return extractHtmlFlopDocument(parseHtmlDocument(html).root);
}

const CTX = { sourceId: "yellowpaper", url: "https://flop.finance/intro/yellowpaper/", detectedAt: "2026-09-10T00:00:00.000Z" };

test("classify: E.38 TBD -> RATIFIED is a watched open item and action_required", () => {
  const v1 = extractFixture("yellowpaper-v1.html");
  const v2 = extractFixture("yellowpaper-v2.html");
  const diff = diffExtractions(toSnapshotEntries(v1.items), toSnapshotEntries(v2.items));
  const e38 = diff.find((d) => d.category === "open_item" && d.itemKey === "E.38")!;
  const change = classifyChange(e38, CTX);
  assert.equal(change.itemId, "E.38");
  assert.equal(change.severity, "action_required");
  assert.equal(change.category, "other");
});

test("classify: an unwatched open item ratifying is 'important', not action_required", () => {
  const entry: ExtractionDiffEntry = {
    category: "open_item",
    itemKey: "E.9",
    changeType: "modified",
    previousValue: { id: "E.9", title: "Governance track magnitudes", status: "TBD", summary: "", blockers: [], sourceSection: "§14.1" },
    currentValue: { id: "E.9", title: "Governance track magnitudes", status: "RATIFIED", summary: "", blockers: [], sourceSection: "§14.1" },
  };
  const change = classifyChange(entry, CTX);
  assert.equal(change.severity, "important");
  assert.equal(change.itemId, "E.9");
});

test("classify: validator_min_stake modification is action_required and category validator", () => {
  const v1 = extractFixture("yellowpaper-v1.html");
  const v2 = extractFixture("yellowpaper-v2.html");
  const diff = diffExtractions(toSnapshotEntries(v1.items), toSnapshotEntries(v2.items));
  const stake = diff.find((d) => d.itemKey === "validator_min_stake")!;
  const change = classifyChange(stake, CTX);
  assert.equal(change.severity, "action_required");
  assert.equal(change.category, "validator");
});

test("classify: an Appendix H item moving PLANNED -> LIVE is action_required, category implementation", () => {
  const v1 = extractFixture("yellowpaper-v1.html");
  const v2 = extractFixture("yellowpaper-v2.html");
  const diff = diffExtractions(toSnapshotEntries(v1.items), toSnapshotEntries(v2.items));
  const metering = diff.find((d) => d.category === "implementation" && d.itemKey.includes("metering_cert_circuit"))!;
  const change = classifyChange(metering, CTX);
  assert.equal(change.severity, "action_required");
  assert.equal(change.category, "implementation");
});

test("classify: a genesis/agent airdrop value change is category 'airdrop'", () => {
  const entry: ExtractionDiffEntry = {
    category: "tokenomics",
    itemKey: "genesis_agent_airdrop",
    changeType: "modified",
    previousValue: { value: "596_030_400 FLOP" },
    currentValue: { value: "600_000_000 FLOP" },
  };
  const change = classifyChange(entry, CTX);
  assert.equal(change.category, "airdrop");
});

test("classify: a testnet date change (meta_testnet) is action_required, category testnet", () => {
  const entry: ExtractionDiffEntry = {
    category: "metadata",
    itemKey: "meta_testnet",
    changeType: "modified",
    previousValue: "Q4 2026",
    currentValue: "Q1 2027",
  };
  const change = classifyChange(entry, CTX);
  assert.equal(change.category, "testnet");
  assert.equal(change.severity, "action_required");
});

test("classify: publishing an inference endpoint/SDK is action_required", () => {
  const entry: ExtractionDiffEntry = {
    category: "agent",
    itemKey: "inference_endpoint",
    changeType: "added",
    currentValue: "https://api.flop.finance/v1/inference",
  };
  const change = classifyChange(entry, CTX);
  assert.equal(change.severity, "action_required");
});

test("classify: a tclk rail moving from 'no rail holds value yet' to live is action_required, category tclk", () => {
  const before = extractMarkdownTclkDocument(parseMarkdownDocument(readFileSync(new URL("./__fixtures__/tclk-readme-v1.md", import.meta.url), "utf8")));
  const after = extractMarkdownTclkDocument(parseMarkdownDocument(readFileSync(new URL("./__fixtures__/tclk-readme-v2-rail-live.md", import.meta.url), "utf8")));
  const diff = diffExtractions(toSnapshotEntries(before.items), toSnapshotEntries(after.items));
  const rail = diff.find((d) => d.itemKey === "rail_status")!;
  const change = classifyChange(rail, { ...CTX, sourceId: "tclk-readme", url: "https://raw.githubusercontent.com/flop-labs/tclk/main/README.md" });
  assert.equal(change.category, "tclk");
  assert.equal(change.severity, "action_required");
});

test("classify: an ordinary added parameter with no special rule is 'info'", () => {
  const entry: ExtractionDiffEntry = { category: "verification", itemKey: "some_new_flag", changeType: "added", currentValue: { value: "1" } };
  const change = classifyChange(entry, CTX);
  assert.equal(change.severity, "info");
});

test("classifyChanges maps a whole diff list in order", () => {
  const entries: ExtractionDiffEntry[] = [
    { category: "tokenomics", itemKey: "a", changeType: "added", currentValue: 1 },
    { category: "tokenomics", itemKey: "b", changeType: "removed", previousValue: 2 },
  ];
  const changes = classifyChanges(entries, CTX);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].field, "a");
  assert.equal(changes[1].field, "b");
});
