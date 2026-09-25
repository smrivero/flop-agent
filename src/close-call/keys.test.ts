import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePaperKeys, findMintEvidence, getKey, IllegalTransition, isTradable, KEY_STATUSES, keyId, listKeys, paperDid, transitionKey } from "./keys.js";
import { FoldIntegrityError, verifyVendor } from "./fold.js";
import { DID_RE } from "./protocol.js";
import { tmpDb, VENDOR } from "./test-helpers.js";
import { fmt, mul, parseAmount, toMicro } from "./decimal.js";

test("CC001..CC100: unique, valid, fake, GENERATED", () => {
  const { db } = tmpDb();
  const keys = ensurePaperKeys(db, 100);
  assert.equal(keys.length, 100);
  assert.equal(keys[0].id, "CC001");
  assert.equal(keys[99].id, "CC100");
  assert.equal(new Set(keys.map((k) => k.did)).size, 100);
  assert.ok(keys.every((k) => DID_RE.test(k.did) && k.fake === 1 && k.key_path === null && k.status === "GENERATED"));
  assert.equal(paperDid("CC001"), keys[0].did, "deterministic");
  ensurePaperKeys(db, 100);
  assert.equal(listKeys(db).length, 100, "idempotent");
});

test("key state machine: only the documented edges, and MINT_CONFIRMED needs explicit evidence", () => {
  const { db } = tmpDb();
  ensurePaperKeys(db, 4);
  const id = keyId(1);
  assert.deepEqual(KEY_STATUSES, ["UNUSED", "GENERATED", "REGISTER_PENDING", "MINT_EXPECTED", "PROBE_PENDING", "MINT_CONFIRMED", "READY", "ACTIVE", "ERROR"]);
  assert.throws(() => transitionKey(db, id, "READY"), IllegalTransition, "GENERATED cannot jump to READY");
  assert.throws(() => transitionKey(db, id, "MINT_CONFIRMED"), IllegalTransition, "must register first");
  transitionKey(db, id, "REGISTER_PENDING");
  assert.equal(isTradable(getKey(db, id).status), false, "a registered key is not tradable");
  assert.throws(() => transitionKey(db, id, "MINT_CONFIRMED"), /explicit referee evidence/, "no inference from time");
  assert.throws(() => transitionKey(db, id, "ACTIVE"), IllegalTransition);
  const k = transitionKey(db, id, "MINT_CONFIRMED", { evidence: { source: "paper-fold", sweep: 7, detail: "t" } });
  assert.equal(k.minted_sweep, 7);
  assert.equal(JSON.parse(k.mint_evidence!).source, "paper-fold");
  assert.equal(isTradable(k.status), false, "MINT_CONFIRMED alone is not READY");
  transitionKey(db, id, "READY");
  assert.equal(isTradable(getKey(db, id).status), true);
  transitionKey(db, id, "ACTIVE");
  assert.throws(() => transitionKey(db, id, "READY"), IllegalTransition, "no way back");
  assert.equal(transitionKey(db, keyId(2), "ERROR", { reason: "lost key file" }).error, "lost key file");
});

test("paper evidence can never confirm a real key; flow evidence is found only when explicitly listed", () => {
  const { db } = tmpDb();
  db.prepare("INSERT INTO keys (id, did, key_path, fake, status, updated_at) VALUES ('R1', ?, '/k', 0, 'REGISTER_PENDING', 'x')").run(paperDid("REAL"));
  assert.throws(() => transitionKey(db, "R1", "MINT_CONFIRMED", { evidence: { source: "paper-fold", sweep: 1, detail: "x" } }), /paper evidence/);
  assert.throws(() => ensurePaperKeys(db, 4), /real keys/);
  const did = paperDid("REAL");
  assert.equal(findMintEvidence(db, did), null);
  db.prepare(`INSERT INTO raw_posts (room, seq, generation, ts, from_did, text, fetched_at) VALUES ('d-close1-flow', 1, 1, 't', 'r', ?, 'x')`)
    .run(JSON.stringify({ t: "flow", n: 9, mints: [], omitted: { mints: 5000 } }));
  assert.equal(findMintEvidence(db, did), null, "an omitted mint is not evidence");
  db.prepare(`INSERT INTO raw_posts (room, seq, generation, ts, from_did, text, fetched_at) VALUES ('d-close1-flow', 2, 1, 't', 'r', ?, 'x')`)
    .run(JSON.stringify({ t: "flow", n: 10, mints: [did] }));
  assert.deepEqual(findMintEvidence(db, did), { source: "flow.mints", sweep: 10, detail: "DID listed in flow.mints" });
});

test("vendored fold integrity: OK as shipped, refused after a one-byte change", () => {
  const v = verifyVendor(VENDOR);
  assert.equal(v.manifestSha256, "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa");
  assert.equal(v.foldSha256, "19e13cd15dd4e9078b608a94776947bb52bba86367446d0a405c0b05c85173d4");
  const dir = mkdtempSync(join(tmpdir(), "cc-vendor-"));
  cpSync(VENDOR, dir, { recursive: true });
  writeFileSync(join(dir, "close_call_fold.py"), "# tampered\n", { flag: "a" });
  assert.throws(() => verifyVendor(dir), FoldIntegrityError);
});

test("decimal: fold-shaped amounts only, exact arithmetic, no silent rounding", () => {
  assert.equal(parseAmount("226.14"), 226_140_000n);
  assert.equal(parseAmount("0001.50"), 1_500_000n);
  for (const bad of ["1e2", "-1", "1.234", "10000000", "0", "0.00", "", " 1"]) assert.equal(parseAmount(bad), null, bad);
  assert.equal(fmt(mul(toMicro("0.01"), mul(toMicro("44.22"), toMicro("226.14")))), "99.999108");
  assert.throws(() => fmt(toMicro("1.005"), 2));
});
