import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "./normalize/html.js";
import { extractHtmlFlopDocument } from "./extract/index.js";
import { diffExtractions, toSnapshotEntries } from "./diff.js";

function extractFixture(name: string) {
  const html = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
  return extractHtmlFlopDocument(parseHtmlDocument(html).root);
}

test("diff: identical extraction sets produce no entries", () => {
  const v1 = extractFixture("yellowpaper-v1.html");
  const diff = diffExtractions(toSnapshotEntries(v1.items), toSnapshotEntries(v1.items));
  assert.deepEqual(diff, []);
});

test("diff: a purely cosmetic HTML change (whitespace/markup/extra classes) produces no diff", () => {
  const v1 = extractFixture("yellowpaper-v1.html");
  const cosmetic = extractFixture("yellowpaper-v1-cosmetic.html");
  const diff = diffExtractions(toSnapshotEntries(v1.items), toSnapshotEntries(cosmetic.items));
  assert.deepEqual(diff, [], "extraction-level content is identical, so no change should be reported");
});

test("diff: v1 -> v2 reports the version metadata change and modified param/open-item/implementation entries", () => {
  const v1 = extractFixture("yellowpaper-v1.html");
  const v2 = extractFixture("yellowpaper-v2.html");
  const diff = diffExtractions(toSnapshotEntries(v1.items), toSnapshotEntries(v2.items));

  const version = diff.find((d) => d.itemKey === "meta_version");
  assert.equal(version?.changeType, "modified");
  assert.equal(version?.previousValue, "0.5.0 (draft)");
  assert.equal(version?.currentValue, "0.5.1 (draft)");

  const e38 = diff.find((d) => d.category === "open_item" && d.itemKey === "E.38");
  assert.equal(e38?.changeType, "modified");

  const validatorStake = diff.find((d) => d.itemKey === "validator_min_stake");
  assert.equal(validatorStake?.changeType, "modified");

  const meteringCert = diff.find((d) => d.category === "implementation" && d.itemKey.includes("metering_cert_circuit"));
  assert.equal(meteringCert?.changeType, "modified");
});

test("diff: an added item shows up as changeType 'added' with no previousValue", () => {
  const before = toSnapshotEntries([{ category: "tokenomics", itemKey: "new_param", value: { value: "1" }, status: "ok" }]);
  const after = toSnapshotEntries([]);
  // added: appears only in "current"
  const diff = diffExtractions(after, before);
  assert.equal(diff[0].changeType, "added");
  assert.equal(diff[0].previousValue, undefined);
});

test("diff: a removed item shows up as changeType 'removed' with no currentValue", () => {
  const before = toSnapshotEntries([{ category: "tokenomics", itemKey: "old_param", value: { value: "1" }, status: "ok" }]);
  const after = toSnapshotEntries([]);
  const diff = diffExtractions(before, after);
  assert.equal(diff[0].changeType, "removed");
  assert.equal(diff[0].currentValue, undefined);
});
