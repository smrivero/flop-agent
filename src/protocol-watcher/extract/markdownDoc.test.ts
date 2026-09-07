import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMarkdownDocument } from "../normalize/markdown.js";
import { extractMarkdownMetadata } from "./markdownDoc.js";

function loadFixture(name: string) {
  return parseMarkdownDocument(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("markdownDoc: CHANGELOG.md's most recent released version becomes the document version", () => {
  const { metadata } = extractMarkdownMetadata(loadFixture("tclk-changelog-v1.md"));
  assert.equal(metadata.version, "0.1.0");
  assert.equal(metadata.updatedAt, "2026-09-01");
});

test("markdownDoc: a new release entry changes the detected version", () => {
  const before = extractMarkdownMetadata(loadFixture("tclk-changelog-v1.md")).metadata;
  const after = extractMarkdownMetadata(loadFixture("tclk-changelog-v2.md")).metadata;
  assert.equal(before.version, "0.1.0");
  assert.equal(after.version, "0.2.0");
});

test("markdownDoc: extracts the README's own Status section body as a diffable item", () => {
  const { items } = extractMarkdownMetadata(loadFixture("tclk-readme-v1.md"));
  const railStatus = items.find((i) => i.itemKey === "rail_status");
  assert.ok(String(railStatus?.value).includes("No rail holds value yet"));
});

test("markdownDoc: rail_status changes when the README announces a live rail", () => {
  const before = extractMarkdownMetadata(loadFixture("tclk-readme-v1.md")).items.find((i) => i.itemKey === "rail_status")?.value;
  const after = extractMarkdownMetadata(loadFixture("tclk-readme-v2-rail-live.md")).items.find((i) => i.itemKey === "rail_status")?.value;
  assert.notEqual(before, after);
  assert.ok(String(after).includes("flop-htlc"));
});
