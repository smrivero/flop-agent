import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLexicon, loadDictionary, CmudictError } from "./cmudict.js";
import { loadSonnetConfig } from "./config.js";

test("parseLexicon: comment handling (# and ;;;) matches the official parser", () => {
  const text = ";;; comment\n# comment\nTEST T EH1 S T\nTEST(2) T EH1 S AH0 T # variant\n";
  const lexicon = parseLexicon(text);
  assert.deepEqual([...lexicon.entries()], [["test", 2]]);
});

test("parseLexicon: throws when no usable pronunciations exist", () => {
  assert.throws(() => parseLexicon("# no usable pronunciations\n"), CmudictError);
});

test("parseLexicon: largest listed syllable count wins across variants", () => {
  const text = "WORD W ER1 D\nWORD(2) W ER1 D IH0 NG\n";
  const lexicon = parseLexicon(text);
  assert.equal(lexicon.get("word"), 2);
});

test("parseLexicon: a leading-apostrophe headword (e.g. 'bout) is excluded, matching WORD.fullmatch", () => {
  const text = "'bout B AW1 T\nABOUT AH0 B AW1 T\n";
  const lexicon = parseLexicon(text);
  assert.equal(lexicon.has("'bout"), false);
  assert.equal(lexicon.get("about"), 2);
});

test("loadDictionary: the vendored package's cmudict.dict verifies against its own pinned upstream hash", () => {
  const config = loadSonnetConfig({});
  const { lexicon, sha256 } = loadDictionary(config);
  assert.ok(lexicon.size > 100_000, `expected a large dictionary, got ${lexicon.size}`);
  assert.equal(sha256, "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22");
});

test("loadDictionary: throws CmudictError when the dictionary bytes don't match the pinned hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "sonnet-cmudict-"));
  writeFileSync(join(dir, "cmudict.dict"), "TAMPERED T AE1 M P ER0 D\n");
  writeFileSync(
    join(dir, "upstream.json"),
    JSON.stringify({ cmudict: { dictionary: { sha256: "0".repeat(64) } } }),
  );
  const config = loadSonnetConfig({ SONNET_VENDOR_ROOT: dir });
  assert.throws(() => loadDictionary(config), CmudictError);
});
