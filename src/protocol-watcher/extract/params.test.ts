import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "../normalize/html.js";
import { extractParameterItems } from "./params.js";

function loadFixture(name: string) {
  return parseHtmlDocument(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("params: extracts every Appendix-A-style parameter row with its value/section/decision/description", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const items = extractParameterItems(root);
  const byKey = Object.fromEntries(items.map((i) => [i.itemKey, i]));

  assert.equal(items.length, 7);
  assert.deepEqual(byKey["genesis_supply"].value, {
    value: "2_483_460_000 FLOP",
    section: "§2.3",
    decision: "D-0421",
    description: "Genesis (pre-emission) total supply.",
  });
  assert.equal(byKey["genesis_supply"].category, "tokenomics");
  assert.equal(byKey["genesis_agent_airdrop"].category, "tokenomics");
  assert.equal(byKey["validator_min_stake"].category, "validator");
  assert.equal(byKey["validator_min_stake"].sourceSection, "Appendix A — Parameter Reference / Validator security policy");
});

test("params: a validator param value change is visible between v1 and v2 fixtures", () => {
  const v1 = extractParameterItems(loadFixture("yellowpaper-v1.html").root);
  const v2 = extractParameterItems(loadFixture("yellowpaper-v2.html").root);
  const before = v1.find((i) => i.itemKey === "validator_min_stake")?.value as { value: string };
  const after = v2.find((i) => i.itemKey === "validator_min_stake")?.value as { value: string };
  assert.equal(before.value, "50_000 FLOP");
  assert.equal(after.value, "75_000 FLOP");
});

test("params: returns an empty list (never throws) on a page with no parameter table", () => {
  const { root } = parseHtmlDocument("<html><body><p>Nothing to see here.</p></body></html>");
  assert.deepEqual(extractParameterItems(root), []);
});
