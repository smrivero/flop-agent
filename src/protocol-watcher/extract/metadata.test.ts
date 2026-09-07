import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "../normalize/html.js";
import { extractHtmlMetadata } from "./metadata.js";

function loadFixture(name: string) {
  return parseHtmlDocument(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("metadata: reads version/status/updated from the .meta block", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const { metadata } = extractHtmlMetadata(root);
  assert.equal(metadata.name, "FLOP Network Yellow Paper");
  assert.equal(metadata.version, "0.5.0 (draft)");
  assert.equal(metadata.status, "Implementation spec — iterating");
  assert.equal(metadata.updatedAt, "2026-09-05");
  assert.ok(metadata.draftBannerText?.startsWith("Draft"));
});

test("metadata: captures every .meta span, including page-specific ones like Testnet/Mainnet", () => {
  const { root } = loadFixture("teaser-v1.html");
  const { items } = extractHtmlMetadata(root);
  const testnet = items.find((i) => i.itemKey === "meta_testnet");
  const mainnet = items.find((i) => i.itemKey === "meta_mainnet");
  assert.equal(testnet?.value, "Q4 2026");
  assert.equal(mainnet?.value, "Q1 2027");
});

test("metadata: the teaser's own draft-banner discloses its non-normative figures", () => {
  const { root } = loadFixture("teaser-v1.html");
  const { metadata } = extractHtmlMetadata(root);
  assert.ok(metadata.draftBannerText?.includes("not yet ratified"));
  assert.ok(metadata.draftBannerText?.includes("2,483,460,000"));
});

test("metadata: falls back to the footer line when there is no .meta block", () => {
  const { root } = parseHtmlDocument(`
    <title>FLOP Network · Verification</title>
    <footer><span>FLOP Network &middot; Project intro</span><span>Draft &middot; Updated 2026-08-27</span></footer>
  `);
  const { metadata } = extractHtmlMetadata(root);
  assert.equal(metadata.status, "Draft");
  assert.equal(metadata.updatedAt, "2026-08-27");
});
