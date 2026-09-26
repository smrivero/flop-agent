/**
 * `live import-seed`: the referee's seed post (rotated out of technocore's ring) copied from the paper DB,
 * read-only, verified on its own (the fixture is the REAL seed #1 of d-close1-price, referee-signed), and
 * nothing else. Idempotent; a different seed already in the live DB is refused, never overwritten.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePaperKeys } from "./keys.js";
import { importSeed, SeedImportRefused, verifySeedMessage } from "./live/import-seed.js";
import { REFEREE_PACKAGE_SHA256 } from "./fold.js";
import { REFEREE_DID } from "./protocol.js";
import { getMeta, now, type CcDb } from "./store.js";
import { contest, tmpDb, VENDOR } from "./test-helpers.js";

const SEED = JSON.parse(readFileSync(join(process.cwd(), "src/close-call/testing/fixtures/referee-seed.json"), "utf8")) as
  { room: string; seq: number; generation: number; ts: string; from_did: string; nonce: string; sig: string; text: string };

const COUNTED = ["keys", "trades", "nonces", "strategy_state", "rooms_state", "live_trades", "write_attempts", "intents", "sweeps", "alerts"];
const counts = (db: CcDb) => Object.fromEntries(COUNTED.map((t) => { try { return [t, (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n]; } catch { return [t, -1]; } }));

/** A paper DB holding the seed AND plenty of other state that must never be copied. */
function paperDb(text = SEED.text, sig = SEED.sig): { path: string; db: CcDb } {
  const { db, dir } = tmpDb();
  db.prepare(`INSERT INTO raw_posts (room, seq, generation, ts, from_did, text, nonce, sig, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SEED.room, SEED.seq, SEED.generation, SEED.ts, SEED.from_did, text, SEED.nonce, sig, now());
  ensurePaperKeys(db, 4, "CC");
  db.prepare("INSERT INTO strategy_state (name, json, updated_at) VALUES ('K', '{\"paper\":true}', ?)").run(now());
  db.prepare("INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES ('CC001', 'room:x', '99', ?)").run(now());
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { path: join(dir, "cc.sqlite3"), db };
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("the fixture is the real referee-signed seed (signature, DID, close-1, pinned package)", () => {
  assert.equal(SEED.from_did, REFEREE_DID);
  const s = verifySeedMessage(SEED, contest(), VENDOR);
  assert.equal(s.package, REFEREE_PACKAGE_SHA256);
  assert.equal(s.price, "226.14");
});

test("import-seed: copies ONLY the verified seed, paper DB untouched, provenance kept; readiness' seed row turns OK", () => {
  const paper = paperDb();
  const before = sha(paper.path);
  const { db: live } = tmpDb();
  const c0 = counts(live);
  const r = importSeed(live, paper.path, contest(), VENDOR);
  assert.equal(r.action, "imported");
  assert.equal(r.seq, 1);
  assert.equal(sha(paper.path), before, "the paper DB file is byte-identical (opened read-only)");
  assert.deepEqual(counts(live), c0, "no keys, trades, nonces, strategy, rooms, journal, intents, sweeps or alerts copied");
  // exactly what live-check's "referee seed" row reads
  const seed = live.prepare("SELECT package, price FROM seed WHERE id = 1").get() as { package: string; price: string };
  const from = (live.prepare("SELECT from_did FROM raw_posts WHERE room = 'd-close1-price' AND text LIKE '%\"t\":\"seed\"%' LIMIT 1").get() as { from_did: string }).from_did;
  assert.equal(seed.package, REFEREE_PACKAGE_SHA256);
  assert.equal(from, REFEREE_DID);
  assert.equal((live.prepare("SELECT COUNT(*) n FROM raw_posts").get() as { n: number }).n, 1, "one raw message: the seed");
  const prov = JSON.parse(getMeta(live, "seed_import")!) as { text_sha256: string; source_opened: string; sig: string; checks: string[] };
  assert.equal(prov.text_sha256, createHash("sha256").update(SEED.text).digest("hex"));
  assert.equal(prov.source_opened, "read-only");
  assert.equal(prov.sig, SEED.sig);
  assert.ok(prov.checks.includes("referee Ed25519 signature"));
});

test("import-seed is idempotent: an identical seed already in live -> nothing", () => {
  const paper = paperDb();
  const { db: live } = tmpDb();
  importSeed(live, paper.path, contest(), VENDOR);
  const prov = getMeta(live, "seed_import");
  const r = importSeed(live, paper.path, contest(), VENDOR);
  assert.equal(r.action, "identical");
  assert.equal(getMeta(live, "seed_import"), prov, "provenance not rewritten");
  assert.equal((live.prepare("SELECT COUNT(*) n FROM raw_posts").get() as { n: number }).n, 1);
});

test("a DIFFERENT seed already in the live DB is refused, never overwritten", () => {
  const paper = paperDb();
  const { db: live } = tmpDb();
  live.prepare("INSERT INTO seed (id, price, tid, time, package, json) VALUES (1, '1.00', '1', 't', 'other', '{\"t\":\"seed\",\"price\":\"1.00\"}')").run();
  assert.throws(() => importSeed(live, paper.path, contest(), VENDOR), (e: Error) => e instanceof SeedImportRefused && /DIFFERENT seed/.test(e.message));
  assert.equal((live.prepare("SELECT price FROM seed WHERE id = 1").get() as { price: string }).price, "1.00", "untouched");
  assert.equal(getMeta(live, "seed_import"), null);
});

test("a tampered seed (text or signature) is refused before anything is written", () => {
  const { db: live } = tmpDb();
  const forged = paperDb(SEED.text.replace('"price":"226.14"', '"price":"226.15"'));
  assert.throws(() => importSeed(live, forged.path, contest(), VENDOR), /signature does NOT verify/);
  const badSig = paperDb(SEED.text, `${SEED.sig.slice(0, -2)}AA`);
  assert.throws(() => importSeed(live, badSig.path, contest(), VENDOR), /signature does NOT verify/);
  assert.equal(live.prepare("SELECT 1 FROM seed").get(), undefined);
  assert.equal((live.prepare("SELECT COUNT(*) n FROM raw_posts").get() as { n: number }).n, 0);
});

test("a message not from the referee, or a paper DB without a seed, is refused", () => {
  assert.throws(() => verifySeedMessage({ ...SEED, from_did: "did:key:z6MkfjxyGSNrkAoAQoif7oFftnfGAozksXtsyzr9Kok83S8L" }, contest(), VENDOR), /expected the referee/);
  const { db, dir } = tmpDb();
  db.close();
  const { db: live } = tmpDb();
  assert.throws(() => importSeed(live, join(dir, "cc.sqlite3"), contest(), VENDOR), /no seed message/);
});
