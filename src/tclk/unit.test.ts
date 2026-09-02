import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, generateHashLock, makeAccept, makeOffer } from "@flop-labs/tclk";
import { generateIdentitySeed } from "../identity.js";
import { TechnocoreClient } from "../technocore.js";
import { assertDistinctPayerAndVerifierDids, loadTclkConfig, TclkConfigError, TclkSameDidError } from "./config.js";
import {
  getContractByFindingId,
  insertOfferedContract,
  listOpenContracts,
  openTclkDatabase,
  updateContractCache,
} from "./database.js";
import { buildLockFrame, buildReceiptFrame, buildRefundFrame, buildRevealFrame } from "./frames.js";
import { planPayerAction } from "./payer.js";
import { planVerifierAction } from "./verifierWorker.js";
import { decodeVerifiedFrames, foldContract, readVerifiedMessages } from "./transcript.js";
import { FakeTechnocore, makeTestIdentity } from "./testUtils.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "flop-agent-tclk-test-"));
}

function writeIdentityFile(path: string): string {
  const { did, seedHex } = generateIdentitySeed();
  writeFileSync(path, JSON.stringify({ did, seedHex }));
  return did;
}

// -- config -------------------------------------------------------------------

test("config: defaults match examples/live-deal.mjs (PAPER asset, paper rail, 1000000 amount)", () => {
  const config = loadTclkConfig({ TCLK_ENABLED: "true", OPENAI_API_KEY: "k" } as NodeJS.ProcessEnv);
  assert.equal(config.rail, "paper");
  assert.equal(config.asset, "PAPER");
  assert.equal(config.amount, "1000000");
});

test("config: TCLK_ALLOWED_PAYER_DID defaults to whatever TECHNOCORE_IDENTITY_PATH resolves to", () => {
  const dir = tempDir();
  const path = join(dir, "identity.json");
  const did = writeIdentityFile(path);
  const config = loadTclkConfig({ TECHNOCORE_IDENTITY_PATH: path } as NodeJS.ProcessEnv);
  assert.equal(config.allowedPayerDid, did);
});

test("config: rejects claimMinutes >= refundMinutes (tclk requires claimByMs < refundAfterMs)", () => {
  assert.throws(
    () => loadTclkConfig({ TCLK_CLAIM_MINUTES: "120", TCLK_REFUND_MINUTES: "60" } as NodeJS.ProcessEnv),
    TclkConfigError,
  );
});

test("config: TCLK_RAIL must be paper -- no other rail is wired up", () => {
  assert.throws(() => loadTclkConfig({ TCLK_RAIL: "flop-htlc" } as NodeJS.ProcessEnv), TclkConfigError);
});

// -- DID safety (test #1: DID A != DID B) --------------------------------------

test("DID guard: distinct DIDs pass silently", () => {
  const a = makeTestIdentity();
  const b = makeTestIdentity();
  assert.doesNotThrow(() => assertDistinctPayerAndVerifierDids(a.did, b.did, "a.json", "b.json"));
});

test("DID guard: identical DIDs (same identity file for both roles) refuses to run", () => {
  const a = makeTestIdentity();
  assert.throws(() => assertDistinctPayerAndVerifierDids(a.did, a.did, "a.json", "a.json"), TclkSameDidError);
});

// -- transcript: local signature re-verification (security) -------------------

test("transcript: a validly signed message is kept", async () => {
  const server = new FakeTechnocore();
  const identity = makeTestIdentity();
  server.postSigned("room", identity, "hello");
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const messages = await readVerifiedMessages(client, "room");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].verifiedFrom, identity.did);
});

test("transcript: an injected message with a spoofed `from` and no real signature is dropped", async () => {
  const server = new FakeTechnocore();
  const real = makeTestIdentity();
  const attacker = makeTestIdentity();
  server.postSigned("room", real, "legit");
  // Planted directly, bypassing the signed lane entirely -- what a hostile
  // unsigned-lane post (or a corrupted record) would look like.
  server.inject("room", { from: attacker.did, text: "tclk1 not even valid json", nonce: 1, sig: undefined });
  server.inject("room", { from: real.did, text: "spoofed as the real DID", nonce: 999, sig: "not-a-real-signature-000000000000000000000000000000000000000000000000000000000AQ" });
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const messages = await readVerifiedMessages(client, "room");
  assert.equal(messages.length, 1); // only the genuinely-signed one survives
  assert.equal(messages[0].text, "legit");
});

test("transcript: a corrupted/non-tclk line among verified messages is ignored, not thrown (test #17)", async () => {
  const server = new FakeTechnocore();
  const identity = makeTestIdentity();
  server.postSigned("room", identity, "just chatting, not a frame");
  server.postSigned("room", identity, "tclk1 {this is not valid json");
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const messages = await readVerifiedMessages(client, "room");
  assert.doesNotThrow(() => decodeVerifiedFrames(messages));
  assert.equal(decodeVerifiedFrames(messages).length, 0);
});

// Regression: a real run hit an AbortError (timeout) reading the room, and it
// killed the entire run before either worker could look at a single
// contract. readVerifiedMessages is a plain GET (safe to retry, unlike a
// signed write) and both workers depend on it for everything -- retry it.
test("transcript: readVerifiedMessages retries a transient network failure and still returns the room's messages", async () => {
  const server = new FakeTechnocore();
  const identity = makeTestIdentity();
  server.postSigned("room", identity, "hello");
  let calls = 0;
  const flakyFetch: typeof fetch = async (input, init) => {
    calls++;
    if (calls < 3) throw new Error("AbortError: This operation was aborted");
    return server.fetch(input, init);
  };
  const client = new TechnocoreClient({ fetchImpl: flakyFetch });
  const messages = await readVerifiedMessages(client, "room", 2);
  assert.equal(calls, 3);
  assert.equal(messages.length, 1);
});

test("transcript: readVerifiedMessages gives up once retries are exhausted, throwing the last error", async () => {
  let calls = 0;
  const alwaysFails: typeof fetch = async () => { calls++; throw new Error("AbortError: This operation was aborted"); };
  const client = new TechnocoreClient({ fetchImpl: alwaysFails });
  await assert.rejects(() => readVerifiedMessages(client, "room", 2));
  assert.equal(calls, 3); // initial attempt + 2 retries
});

// -- transcript: fold via applyFrame replays correctly (test #16) -------------

test("transcript: foldContract replays offer+accept+lock+reveal to the correct terminal state", () => {
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const now = Date.now();
  const offer = makeOffer({
    from: payer.did, role: "payer", lock: "hash", amount: "1000000", asset: "PAPER", rails: ["paper"],
    claimByMs: now + 60_000, refundAfterMs: now + 120_000, expiresMs: now + 30_000,
  });
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
  const lockFrame = buildLockFrame({ from: payer.did, contract: accept.contract, rail: "paper", ref: accept.contract });
  const revealFrame = buildRevealFrame({ from: payee.did, contract: accept.contract, secret: lock.preimage });

  const frames = [offer, accept, lockFrame, revealFrame].map((frame, i) => ({ seq: i + 1, from: (frame as { from: string }).from, frame }));
  const folded = foldContract(offer, frames as Parameters<typeof foldContract>[1]);

  assert.equal(folded.state.status, "claimed");
  assert.equal(folded.state.secret, lock.preimage);
  assert.equal(folded.messageIds.accept, 2);
  assert.equal(folded.messageIds.lock, 3);
  assert.equal(folded.messageIds.reveal, 4);
});

test("transcript: a bogus/duplicate frame in the middle of the fold is rejected without breaking the fold (applyFrame fail-closed)", () => {
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const now = Date.now();
  const offer = makeOffer({
    from: payer.did, role: "payer", lock: "hash", amount: "1000000", asset: "PAPER", rails: ["paper"],
    claimByMs: now + 60_000, refundAfterMs: now + 120_000, expiresMs: now + 30_000,
  });
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
  const lockFrame = buildLockFrame({ from: payer.did, contract: accept.contract, rail: "paper", ref: accept.contract });
  // A second, duplicate lock -- must be rejected, state stays "locked" not re-applied.
  const duplicateLock = buildLockFrame({ from: payer.did, contract: accept.contract, rail: "paper", ref: "different-ref" });

  const frames = [offer, accept, lockFrame, duplicateLock].map((frame, i) => ({ seq: i + 1, from: (frame as { from: string }).from, frame }));
  const folded = foldContract(offer, frames as Parameters<typeof foldContract>[1]);
  assert.equal(folded.state.status, "locked");
  assert.equal(folded.state.railRef, accept.contract); // the FIRST lock's ref, not the duplicate's
});

// -- database -------------------------------------------------------------------

test("database: a finding gets exactly one contract row, ever (insertOfferedContract + idempotency check)", () => {
  const db = openTclkDatabase(join(tempDir(), "db.sqlite3"));
  assert.equal(getContractByFindingId(db, "radar-1"), undefined);
  insertOfferedContract(db, { findingId: "radar-1", offerId: "0xabc", offerMessageId: "1" });
  const row = getContractByFindingId(db, "radar-1")!;
  assert.equal(row.cached_status, "proposed");
  assert.throws(() => insertOfferedContract(db, { findingId: "radar-1", offerId: "0xdef", offerMessageId: "2" })); // UNIQUE(finding_id)
  db.close();
});

test("database: listOpenContracts excludes refunded/cancelled/receipted, but NOT claimed (a claimed contract still needs a receipt)", () => {
  const db = openTclkDatabase(join(tempDir(), "db.sqlite3"));
  insertOfferedContract(db, { findingId: "radar-1", offerId: "0x1", offerMessageId: "1" });
  insertOfferedContract(db, { findingId: "radar-2", offerId: "0x2", offerMessageId: "2" });
  insertOfferedContract(db, { findingId: "radar-3", offerId: "0x3", offerMessageId: "3" });
  updateContractCache(db, "radar-2", { cachedStatus: "refunded" });
  updateContractCache(db, "radar-3", { cachedStatus: "claimed" });
  const open = listOpenContracts(db);
  assert.deepEqual(open.map((r) => r.finding_id).sort(), ["radar-1", "radar-3"]);
  db.close();
});

// -- frame builders (test #4-ish: a real, valid frame) -------------------------

test("frames: buildLockFrame/buildRevealFrame/buildRefundFrame/buildReceiptFrame all encode as valid tclk/1 lines", () => {
  const from = makeTestIdentity().did;
  const contract = "0x" + "a".repeat(64);
  assert.match(encodeFrame(buildLockFrame({ from, contract, rail: "paper", ref: "x" })), /^tclk1 /);
  assert.match(encodeFrame(buildRevealFrame({ from, contract, secret: "0x" + "b".repeat(64) })), /^tclk1 /);
  assert.match(encodeFrame(buildRefundFrame({ from, contract })), /^tclk1 /);
  assert.match(encodeFrame(buildReceiptFrame({ from, contract, outcome: "claimed" })), /^tclk1 /);
});

// -- pure planning functions ----------------------------------------------------

test("planPayerAction: proposed -> none, accepted -> lock, locked (before refund window) -> none, locked (after) -> refund", () => {
  const base = { offer: { refundAfterMs: 1000 } } as Parameters<typeof planPayerAction>[0];
  assert.equal(planPayerAction({ ...base, status: "proposed" }, 0, false).kind, "none");
  assert.equal(planPayerAction({ ...base, status: "accepted" }, 0, false).kind, "lock");
  assert.equal(planPayerAction({ ...base, status: "locked" }, 500, false).kind, "none"); // test #14: no refund before timeout
  assert.equal(planPayerAction({ ...base, status: "locked" }, 1500, false).kind, "refund"); // test #13: refund after timeout
});

test("planPayerAction: claimed without a verification message -> none; with one -> receipt (test #12)", () => {
  const base = { offer: { refundAfterMs: 1000 }, status: "claimed" } as Parameters<typeof planPayerAction>[0];
  assert.equal(planPayerAction(base, 0, false).kind, "none");
  assert.equal(planPayerAction(base, 0, true).kind, "receipt");
});

test("planVerifierAction: accepted -> none (must not work before lock, test #8), locked -> work_and_reveal (test #9)", () => {
  assert.equal(planVerifierAction({ status: "accepted" } as Parameters<typeof planVerifierAction>[0], false).kind, "none");
  assert.equal(planVerifierAction({ status: "locked" } as Parameters<typeof planVerifierAction>[0], false).kind, "work_and_reveal");
});
