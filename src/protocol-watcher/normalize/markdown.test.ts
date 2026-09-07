import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownDocument } from "./markdown.js";

test("normalize/markdown: extracts headings", () => {
  const md = "# Changelog\n\nsome text\n\n## [Unreleased]\n\n### Added\n\n- a thing\n";
  const { headings } = parseMarkdownDocument(md);
  assert.deepEqual(headings, [
    { level: 1, text: "Changelog" },
    { level: 2, text: "[Unreleased]" },
    { level: 3, text: "Added" },
  ]);
});

test("normalize/markdown: extracts Keep-a-Changelog version entries with and without a date", () => {
  const md = "## [Unreleased]\n\n## [0.1.0] - 2026-09-01\n\nfixed things\n";
  const { changelogEntries } = parseMarkdownDocument(md);
  assert.deepEqual(changelogEntries, [
    { version: "Unreleased", date: undefined },
    { version: "0.1.0", date: "2026-09-01" },
  ]);
});

test("normalize/markdown: whitespace-only differences normalize identically", () => {
  const a = "# Title\n\nHello   world\n";
  const b = "# Title\r\nHello world\r\n\r\n";
  assert.equal(parseMarkdownDocument(a).normalizedText, parseMarkdownDocument(b).normalizedText);
});
