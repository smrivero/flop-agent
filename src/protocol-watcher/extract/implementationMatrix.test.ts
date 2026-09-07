import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHtmlDocument } from "../normalize/html.js";
import { extractImplementationItems, implementationItemKey } from "./implementationMatrix.js";

function loadFixture(name: string) {
  return parseHtmlDocument(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8"));
}

test("implementationMatrix: reads area/requirement/section/status/codePath/tracker across differently-shaped tables", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const items = extractImplementationItems(root);

  const babe = items.find((i) => i.requirement.includes("BABE"))!;
  assert.equal(babe.area, "H.1 Core protocol");
  assert.equal(babe.section, "§2");
  assert.equal(babe.status, "LIVE");
  assert.equal(babe.codePath, "pallet_aleph");

  const tee = items.find((i) => i.requirement.includes("TEE attestation"))!;
  assert.equal(tee.area, "H.2 Verification (§3)");
  assert.equal(tee.section, "§3", "falls back to the (§N) in the area heading when the table has no § column");
  assert.equal(tee.status, "LIVE");
});

test("implementationMatrix: a GAP status is recognized even with trailing detail text", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const items = extractImplementationItems(root);
  const proofs = items.find((i) => i.requirement.includes("Three safety sub-proofs"))!;
  assert.equal(proofs.status, "GAP");
});

test("implementationMatrix: PLANNED -> LIVE between v1 and v2 fixtures, same item key", () => {
  const before = extractImplementationItems(loadFixture("yellowpaper-v1.html").root).find((i) => i.requirement.includes("Metering cert circuit"))!;
  const after = extractImplementationItems(loadFixture("yellowpaper-v2.html").root).find((i) => i.requirement.includes("Metering cert circuit"))!;
  assert.equal(before.status, "PLANNED");
  assert.equal(after.status, "LIVE");
  assert.equal(implementationItemKey(before), implementationItemKey(after));
});

test("implementationMatrix: does not confuse an Appendix-A parameter table for an implementation matrix table", () => {
  const { root } = loadFixture("yellowpaper-v1.html");
  const items = extractImplementationItems(root);
  assert.ok(!items.some((i) => i.requirement.includes("genesis_supply")));
});
