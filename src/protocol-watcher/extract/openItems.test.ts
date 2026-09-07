import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "../normalize/html.js";
import { extractOpenItems } from "./openItems.js";

function loadFixture(name: string) {
  return parseHtmlDocument(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("openItems: parses id, title, status, placeholder, home section and blockers", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const items = extractOpenItems(root);
  const e8 = items.find((i) => i.id === "E.8")!;
  assert.equal(e8.status, "TBD");
  assert.match(e8.title, /Value-coupled floor/);
  assert.ok(e8.placeholder?.includes("k"));
  assert.equal(e8.sourceSection, "§11, §15.2");
  assert.deepEqual(e8.blockers, ["#556"]);
});

test("openItems: multiple blockers are split into an array", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const e38 = extractOpenItems(root).find((i) => i.id === "E.38")!;
  assert.equal(e38.status, "TBD");
  assert.deepEqual(e38.blockers, ["#448", "#848"]);
});

test("openItems: E.38 flips from TBD to RATIFIED between v1 and v2 fixtures", () => {
  const before = extractOpenItems(loadFixture("yellowpaper-v1.html").root).find((i) => i.id === "E.38")!;
  const after = extractOpenItems(loadFixture("yellowpaper-v2.html").root).find((i) => i.id === "E.38")!;
  assert.equal(before.status, "TBD");
  assert.equal(after.status, "RATIFIED");
  assert.deepEqual(after.blockers, [], "a closed item with no remaining blockers");
});

test("openItems: a status tag embedded in surrounding prose (prompt injection) never overrides the real <code>[TAG]</code> status", () => {
  const { root } = loadFixture("prompt-injection.html");
  const e38 = extractOpenItems(root).find((i) => i.id === "E.38")!;
  assert.equal(e38.status, "TBD", "the structural [TBD] code tag is authoritative, not the injected prose");
});
