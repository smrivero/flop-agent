import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "../normalize/html.js";
import { parseMarkdownDocument } from "../normalize/markdown.js";
import { extractByKind, extractHtmlFlopDocument } from "./index.js";

function loadHtmlFixture(name: string) {
  return parseHtmlDocument(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("extract/index: a full yellowpaper page extracts metadata + params + open items + implementation, no warnings", () => {
  const { root } = loadHtmlFixture("yellowpaper-v1.html");
  const outcome = extractHtmlFlopDocument(root);
  assert.ok(outcome.items.some((i) => i.category === "tokenomics"));
  assert.ok(outcome.items.some((i) => i.category === "open_item"));
  assert.ok(outcome.items.some((i) => i.category === "implementation"));
  assert.deepEqual(outcome.warnings, []);
});

test("extract/index: a lightweight page with none of the appendices produces warnings but never throws", () => {
  const { root } = parseHtmlDocument("<html><head><title>Verification</title></head><body><footer><span>x</span><span>Draft &middot; Updated 2026-08-27</span></footer></body></html>");
  const outcome = extractHtmlFlopDocument(root);
  assert.ok(outcome.warnings.length >= 3);
  assert.ok(outcome.items.length > 0, "metadata is still extracted");
});

test("extract/index: malformed/unclosed HTML degrades gracefully instead of throwing", () => {
  const { root } = loadHtmlFixture("malformed.html");
  assert.doesNotThrow(() => extractHtmlFlopDocument(root));
});

test("extract/index: an empty document extracts an empty (not thrown) result", () => {
  const { root } = parseHtmlDocument("");
  const outcome = extractHtmlFlopDocument(root);
  assert.deepEqual(outcome.items.filter((i) => i.category !== "metadata"), []);
});

test("extract/index: prompt-injection content is extracted as inert data, not followed", () => {
  const { root } = loadHtmlFixture("prompt-injection.html");
  const outcome = extractHtmlFlopDocument(root);
  const e38 = outcome.items.find((i) => i.category === "open_item" && i.itemKey === "E.38");
  assert.equal((e38?.value as { status: string }).status, "TBD");
});

test("extract/index: dispatches markdown-tclk sources through the markdown extractor", () => {
  const doc = parseMarkdownDocument("# tclk\n\n## Status\n\nAlpha.\n");
  const outcome = extractByKind("markdown-tclk", { markdown: doc });
  assert.ok(outcome.items.some((i) => i.itemKey === "name" && i.value === "tclk"));
});
