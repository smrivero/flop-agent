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

test("params: a short 'Parameter | Value' summary table (prose cells, no <code> name) is not mistaken for Appendix A -- regression for the real §9 'Total genesis supply' row", () => {
  const html = `
    <h2 id="9-emission--supply">9. Emission &amp; Supply</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Parameter</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Total genesis supply</td><td><a href="#param-genesis_supply"><code>genesis_supply</code></a> = 4,400,000,000 FLOP (no VC pre-mint, no auction) &mdash; three airdrops: <a href="#param-genesis_miner_airdrop"><code>genesis_miner_airdrop</code></a> = 1,200,000,000</td></tr>
        <tr><td>Era 0 block reward</td><td><a href="#param-initial_block_reward"><code>initial_block_reward</code></a> = 96 FLOP/block</td></tr>
      </tbody>
    </table></div>
    <h2 id="appendix-a--parameter-reference">Appendix A &mdash; Parameter Reference</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Parameter</th><th>Value</th><th>&#167;</th><th>Decision</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><a id="param-genesis_supply"></a><code>genesis_supply</code></td><td>4_400_000_000 FLOP</td><td><a href="#sec">&#167;9.3</a></td><td>D-0440</td><td>Genesis total supply.</td></tr>
      </tbody>
    </table></div>
  `;
  const { root } = parseHtmlDocument(html);
  const items = extractParameterItems(root);

  assert.equal(items.length, 1, "only the real Appendix A row should be extracted, not the two summary-table rows");
  assert.equal(items[0].itemKey, "genesis_supply");
  assert.equal((items[0].value as { value: string }).value, "4_400_000_000 FLOP", "the clean canonical value, not the prose sentence from the summary table");
  assert.ok(!items.some((i) => i.itemKey === "Total genesis supply"));
  assert.ok(!items.some((i) => i.itemKey === "Era 0 block reward"));
});
