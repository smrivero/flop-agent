import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtmlDocument } from "./html.js";

test("normalize/html: strips script, style, svg and nav noise before hashing", () => {
  const html = `
    <html><body>
      <nav>Home | About</nav>
      <style>.x{color:red}</style>
      <script>doEvilThings()</script>
      <svg><path d="M0 0"/></svg>
      <h1 id="intro">Introduction</h1>
      <p>Real   content   here.</p>
    </body></html>
  `;
  const { normalizedText } = parseHtmlDocument(html);
  assert.ok(!normalizedText.includes("doEvilThings"));
  assert.ok(!normalizedText.includes("color:red"));
  assert.ok(!normalizedText.includes("Home | About"));
  assert.ok(normalizedText.includes("Introduction"));
  assert.ok(normalizedText.includes("Real content here."));
});

test("normalize/html: two documents differing only in whitespace/formatting normalize identically", () => {
  const a = "<p>Hello   world</p>";
  const b = "<p>\n  Hello world\n</p>";
  assert.equal(parseHtmlDocument(a).normalizedText, parseHtmlDocument(b).normalizedText);
});

test("normalize/html: removes the .toc table-of-contents block", () => {
  const html = `<details class="toc"><a href="#a">A</a></details><h2 id="a">A</h2><p>Body.</p>`;
  const { normalizedText } = parseHtmlDocument(html);
  assert.equal(normalizedText, "A Body.");
});

test("normalize/html: root DOM stays queryable for structural extraction", () => {
  const html = `<h2 id="appendix-e">Appendix E</h2><p><strong>E.38 &mdash; Something.</strong> Detail.</p>`;
  const { root } = parseHtmlDocument(html);
  const h2 = root.querySelector("#appendix-e");
  assert.equal(h2?.text, "Appendix E");
  const strong = root.querySelector("strong");
  assert.ok(strong?.text.startsWith("E.38"));
});
