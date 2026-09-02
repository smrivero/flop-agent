/**
 * End-to-end TCLK choreography, entirely in memory: a real Radar finding in a
 * real (temp) SQLite file, a real @flop-labs/tclk state machine, a real
 * PaperRail, and a real TechnocoreClient -- all talking to an in-process fake
 * Technocore server (testUtils.ts) instead of the network. OpenAI and the
 * independent article fetch are the only two things mocked (fetchArticleFn /
 * analyzeFn injected into runTclkVerifier), per the "no real Technocore/
 * OpenAI/Tavily" test-mode requirement -- the TCLK choreography itself is 100%
 * real code, not simulated.
 *
 *   A creates finding -> A OFFER -> B ACCEPT -> A LOCK -> B verifies (mock
 *   source) -> B posts VERIFIED -> B REVEAL -> A RECEIPT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDiscovered, markPublished as markMentionPublished, openDatabase as openMentionsDatabase } from "../mentions/database.js";
import type { Candidate } from "../mentions/types.js";
import { assertDistinctPayerAndVerifierDids, type TclkConfig } from "./config.js";
import { getContractByFindingId, migrateTclkTables, openTclkDatabase } from "./database.js";
import { openSecretStore } from "./secretStore.js";
import { ensureTclkOffer } from "./radarOffer.js";
import { runTclkPayer } from "./payer.js";
import { runTclkVerifier } from "./verifierWorker.js";
import { FakeTechnocore, makeTestIdentity } from "./testUtils.js";
import { TechnocoreClient } from "../technocore.js";
import { decodeVerifiedFrames, foldContract, readVerifiedMessages } from "./transcript.js";
import type { OfferFrame } from "@flop-labs/tclk";

const ROOM = "d-technocore-radar";

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "flop-agent-tclk-e2e-")), name);
}

function baseConfig(overrides: Partial<TclkConfig> = {}): TclkConfig {
  return {
    tclkEnabled: true,
    rail: "paper",
    offerExpiresMinutes: 30,
    claimMinutes: 60,
    refundMinutes: 120,
    amount: "1000000",
    asset: "PAPER",
    allowedPayerDid: "",
    room: ROOM,
    identityPath: ".technocore/identity.json",
    verifierIdentityPath: ".technocore/identityB.json",
    httpTimeoutMs: 15000,
    maxRetries: 0,
    dbPath: "",
    secretsPath: "",
    payerLockPath: "/dev/null",
    verifierLockPath: "/dev/null",
    ...overrides,
  };
}

function noopLog(): void {}

function seedFinding(dbPath: string, findingId: string, urlSuffix = "1"): void {
  const db = openMentionsDatabase(dbPath);
  const candidate: Candidate = {
    canonicalUrl: `https://example.com/technocore-article-${urlSuffix}`,
    urlHash: `hash-${urlSuffix}`,
    originalUrl: `https://example.com/technocore-article-${urlSuffix}`,
    title: "An article about Technocore",
    domain: "example.com",
    snippet: "snippet",
    searchQuery: "Technocore",
    searchProvider: "tavily",
  };
  const id = insertDiscovered(db, candidate);
  markMentionPublished(db, id, ROOM, "1", "The page describes Technocore.", "content-hash");
  db.prepare(`UPDATE mentions SET finding_id = ? WHERE id = ?`).run(findingId, id);
  db.close();
}

const mockFetchOk = async () => ({ kind: "ok" as const, html: "<html><body>Technocore coordinates agents over signed messages.</body></html>" });
const mockAnalyzeVerified = async () => ({ result: "VERIFIED" as const, reason: "The fetched content supports the finding." });

test("e2e: full tclk choreography -- finding -> offer -> accept -> lock -> verify -> reveal -> receipt", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  assertDistinctPayerAndVerifierDids(payer.did, payee.did, "a", "b"); // test #1

  const dbPath = tempPath("mentions.sqlite3");
  const secretsPath = tempPath("secrets.sqlite3");
  const findingId = "radar-20260902-abc123";
  seedFinding(dbPath, findingId);

  const payerClient = new TechnocoreClient({ fetchImpl: server.fetch });
  const payeeClient = new TechnocoreClient({ fetchImpl: server.fetch });
  const payerConfig = baseConfig({ dbPath, allowedPayerDid: payer.did });
  const payeeConfig = baseConfig({ dbPath, allowedPayerDid: payer.did });

  // -- A: finding already published (seeded above) -> OFFER --------------------
  const payerDb = openTclkDatabase(dbPath);
  const offerOutcome = await ensureTclkOffer(payerDb, payerClient, payerConfig, payer, { findingId }, noopLog);
  assert.equal(offerOutcome.skipped, false);
  assert.equal(offerOutcome.offer?.role, "payer"); // test #4: a valid OFFER exists

  // Re-running the offer step is a no-op -- one contract per finding, forever.
  const second = await ensureTclkOffer(payerDb, payerClient, payerConfig, payer, { findingId }, noopLog);
  assert.equal(second.skipped, true);
  payerDb.close();

  // -- B: ACCEPT -----------------------------------------------------------------
  let fetchCalls = 0;
  let analyzeCalls = 0;
  const countingFetch = async (...args: Parameters<typeof mockFetchOk>) => { fetchCalls++; return mockFetchOk(...args); };
  const countingAnalyze = async (...args: Parameters<typeof mockAnalyzeVerified>) => { analyzeCalls++; return mockAnalyzeVerified(...args); };

  const payeeDb1 = openTclkDatabase(dbPath);
  const secretDb1 = openSecretStore(secretsPath);
  const acceptSummary = await runTclkVerifier({
    db: payeeDb1, secretDb: secretDb1, client: payeeClient, config: payeeConfig, identity: payee,
    openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog,
    fetchArticleFn: countingFetch, analyzeFn: countingAnalyze,
  });
  assert.equal(acceptSummary.acceptedCount, 1); // test #6: ACCEPT
  assert.equal(fetchCalls, 0);
  assert.equal(analyzeCalls, 0); // test #8: no work before LOCK
  secretDb1.close();
  payeeDb1.close();

  // -- A: LOCK ---------------------------------------------------------------
  const payerDb2 = openTclkDatabase(dbPath);
  const lockSummary = await runTclkPayer({ db: payerDb2, client: payerClient, config: payerConfig, identity: payer, dryRun: false, log: noopLog });
  assert.equal(lockSummary.contracts[0]?.action.kind, "lock");
  assert.equal(lockSummary.contracts[0]?.posted?.kind, "lock"); // test #7: LOCK
  payerDb2.close();

  // -- B: WORK + verification result + REVEAL --------------------------------
  const payeeDb2 = openTclkDatabase(dbPath);
  const secretDb2 = openSecretStore(secretsPath);
  const workSummary = await runTclkVerifier({
    db: payeeDb2, secretDb: secretDb2, client: payeeClient, config: payeeConfig, identity: payee,
    openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog,
    fetchArticleFn: countingFetch, analyzeFn: countingAnalyze,
  });
  assert.equal(fetchCalls, 1); // test #9: independent fetch happens after LOCK
  assert.equal(analyzeCalls, 1);
  assert.equal(workSummary.contracts.find((c) => c.findingId === findingId)?.posted?.kind, "reveal");
  secretDb2.close();
  payeeDb2.close();

  // test #10: the verification result was posted BEFORE the reveal (seq order).
  const messages = await readVerifiedMessages(payerClient, ROOM);
  const verificationMsg = messages.find((m) => m.text.startsWith("Technocore Verification"));
  const revealMsg = messages.find((m) => { const f = decodeVerifiedFrames([m])[0]; return f?.frame.type === "reveal"; });
  assert.ok(verificationMsg && revealMsg);
  assert.ok(verificationMsg!.seq < revealMsg!.seq);

  // test #11: the revealed secret actually verifies against the accept statement.
  const frames = decodeVerifiedFrames(messages);
  const offerFrame = frames.find((f) => f.frame.type === "offer")!.frame as OfferFrame;
  const folded = foldContract(offerFrame, frames);
  assert.equal(folded.state.status, "claimed");
  assert.equal(folded.state.secret !== undefined, true);

  // -- A: RECEIPT (only after a verified terminal state, test #12) ------------
  const payerDb3 = openTclkDatabase(dbPath);
  const receiptSummary = await runTclkPayer({ db: payerDb3, client: payerClient, config: payerConfig, identity: payer, dryRun: false, log: noopLog });
  assert.equal(receiptSummary.contracts[0]?.posted?.kind, "receipt");
  payerDb3.close();

  // -- Final state, from applyFrame alone -------------------------------------
  const finalMessages = await readVerifiedMessages(payerClient, ROOM);
  const finalFrames = decodeVerifiedFrames(finalMessages);
  const finalOffer = finalFrames.find((f) => f.frame.type === "offer")!.frame as OfferFrame;
  const finalState = foldContract(finalOffer, finalFrames).state;
  assert.equal(finalState.status, "claimed"); // contract state = claimed
  assert.ok(finalMessages.some((m) => m.text.startsWith("Technocore Verification"))); // verification exists
  assert.ok(finalFrames.some((f) => f.frame.type === "receipt")); // receipt exists

  // -- test #15: duplicate cron runs do not duplicate any frame ---------------
  const messageCountBefore = finalMessages.length;
  const payerDb4 = openTclkDatabase(dbPath);
  await runTclkPayer({ db: payerDb4, client: payerClient, config: payerConfig, identity: payer, dryRun: false, log: noopLog });
  payerDb4.close();
  const payeeDb3 = openTclkDatabase(dbPath);
  const secretDb3 = openSecretStore(secretsPath);
  await runTclkVerifier({
    db: payeeDb3, secretDb: secretDb3, client: payeeClient, config: payeeConfig, identity: payee,
    openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog,
    fetchArticleFn: countingFetch, analyzeFn: countingAnalyze,
  });
  secretDb3.close();
  payeeDb3.close();
  const messagesAfterRerun = await readVerifiedMessages(payerClient, ROOM);
  assert.equal(messagesAfterRerun.length, messageCountBefore); // nothing new posted
  assert.equal(fetchCalls, 1); // still just the one real verification -- no re-spend
  assert.equal(analyzeCalls, 1);
});

test("e2e restart: a fresh payer DB connection between ACCEPT and LOCK still locks correctly (test #18)", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const findingId = "radar-20260902-restart1";
  seedFinding(dbPath, findingId);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const payerConfig = baseConfig({ dbPath, allowedPayerDid: payer.did });

  const db1 = openTclkDatabase(dbPath);
  await ensureTclkOffer(db1, client, payerConfig, payer, { findingId }, noopLog);
  db1.close();

  const secretDb = openSecretStore(tempPath("secrets.sqlite3"));
  const dbB = openTclkDatabase(dbPath);
  await runTclkVerifier({
    db: dbB, secretDb, client, config: payerConfig, identity: payee, openAiApiKey: "k", verifierModel: "m",
    dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified,
  });
  dbB.close();
  secretDb.close();

  // Simulate a restart: brand-new db connection, no in-memory state carried over.
  const dbFresh = openTclkDatabase(dbPath);
  const summary = await runTclkPayer({ db: dbFresh, client, config: payerConfig, identity: payer, dryRun: false, log: noopLog });
  assert.equal(summary.contracts[0]?.posted?.kind, "lock");
  dbFresh.close();
});

test("e2e restart: a fresh verifier DB+secret-store connection between verification and reveal still reveals, without re-analyzing (test #19)", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const secretsPath = tempPath("secrets.sqlite3");
  const findingId = "radar-20260902-restart2";
  seedFinding(dbPath, findingId);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const config = baseConfig({ dbPath, allowedPayerDid: payer.did });

  const db1 = openTclkDatabase(dbPath);
  await ensureTclkOffer(db1, client, config, payer, { findingId }, noopLog);
  db1.close();

  const secretDb1 = openSecretStore(secretsPath);
  const dbB1 = openTclkDatabase(dbPath);
  await runTclkVerifier({ db: dbB1, secretDb: secretDb1, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified });
  secretDb1.close();
  dbB1.close();

  const dbA = openTclkDatabase(dbPath);
  await runTclkPayer({ db: dbA, client, config, identity: payer, dryRun: false, log: noopLog });
  dbA.close();

  // Manually post the verification message, as if a prior worker run reached
  // that point and crashed before posting the reveal.
  const contractRow = (() => {
    const db = openTclkDatabase(dbPath);
    const row = getContractByFindingId(db, findingId)!;
    db.close();
    return row;
  })();
  await client.sendSignedMessage(
    ROOM,
    `Technocore Verification\n\nFinding: ${findingId}\nContract: ${contractRow.tclk_contract_id}\n\nResult: VERIFIED\n\nmanually planted, simulating a crash before reveal\n\nSource:\nhttps://example.com/technocore-article`,
    { identity: payee },
  );

  let analyzeCalls = 0;
  const countingAnalyze = async (...args: Parameters<typeof mockAnalyzeVerified>) => { analyzeCalls++; return mockAnalyzeVerified(...args); };

  const secretDb2 = openSecretStore(secretsPath); // fresh connection -- preimage must still be there
  const dbB2 = openTclkDatabase(dbPath);
  const summary = await runTclkVerifier({ db: dbB2, secretDb: secretDb2, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: countingAnalyze });
  secretDb2.close();
  dbB2.close();

  assert.equal(analyzeCalls, 0); // did not re-spend OpenAI on the already-published result
  assert.equal(summary.contracts.find((c) => c.findingId === findingId)?.posted?.kind, "reveal");
});

test("e2e restart: a fresh payer connection after REVEAL but before RECEIPT still issues the receipt (test #20)", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const findingId = "radar-20260902-restart3";
  seedFinding(dbPath, findingId);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const config = baseConfig({ dbPath, allowedPayerDid: payer.did });

  const db1 = openTclkDatabase(dbPath);
  await ensureTclkOffer(db1, client, config, payer, { findingId }, noopLog);
  db1.close();
  const secretDb = openSecretStore(tempPath("secrets.sqlite3"));
  const dbB1 = openTclkDatabase(dbPath);
  await runTclkVerifier({ db: dbB1, secretDb, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified });
  dbB1.close();
  const dbA1 = openTclkDatabase(dbPath);
  await runTclkPayer({ db: dbA1, client, config, identity: payer, dryRun: false, log: noopLog });
  dbA1.close();
  const dbB2 = openTclkDatabase(dbPath);
  await runTclkVerifier({ db: dbB2, secretDb, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified });
  dbB2.close();
  secretDb.close();

  // Fresh connection = simulated restart.
  const dbA2 = openTclkDatabase(dbPath);
  const summary = await runTclkPayer({ db: dbA2, client, config, identity: payer, dryRun: false, log: noopLog });
  dbA2.close();
  assert.equal(summary.contracts[0]?.posted?.kind, "receipt");
});

test("e2e security: an offer from an unknown payer DID is never accepted (test #5)", async () => {
  const server = new FakeTechnocore();
  const trustedPayer = makeTestIdentity();
  const stranger = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const findingId = "radar-20260902-stranger";
  seedFinding(dbPath, findingId);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  // The stranger posts a well-formed, validly-signed, but untrusted offer.
  const strangerConfig = baseConfig({ dbPath, allowedPayerDid: trustedPayer.did });
  const db0 = openTclkDatabase(dbPath);
  await ensureTclkOffer(db0, client, { ...strangerConfig, allowedPayerDid: stranger.did }, stranger, { findingId }, noopLog);
  db0.close();

  const secretDb = openSecretStore(tempPath("secrets.sqlite3"));
  const db1 = openTclkDatabase(dbPath);
  const summary = await runTclkVerifier({
    db: db1, secretDb, client, config: strangerConfig, identity: payee, openAiApiKey: "k", verifierModel: "m",
    dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified,
  });
  db1.close();
  secretDb.close();
  assert.equal(summary.acceptedCount, 0); // never accepted -- payer DID doesn't match
});

test("e2e refund: no reveal before refundAfterMs -> no refund (test #14); after it -> refund (test #13)", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const findingId = "radar-20260902-refund";
  seedFinding(dbPath, findingId);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  // A short refund window so the test doesn't need to wait long minutes --
  // still strictly claimByMs < refundAfterMs, same shape as production.
  const config = baseConfig({ dbPath, allowedPayerDid: payer.did, claimMinutes: 1, refundMinutes: 2 });

  const db1 = openTclkDatabase(dbPath);
  await ensureTclkOffer(db1, client, config, payer, { findingId }, noopLog);
  db1.close();
  const secretDb = openSecretStore(tempPath("secrets.sqlite3"));
  const dbB = openTclkDatabase(dbPath);
  // Verifier accepts but never does the work -- the failure mode this test covers.
  await runTclkVerifier({ db: dbB, secretDb, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m", dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified });
  dbB.close();

  let clock = Date.now();
  const dbA1 = openTclkDatabase(dbPath);
  const beforeTimeout = await runTclkPayer({ db: dbA1, client, config, identity: payer, dryRun: false, log: noopLog, now: () => clock });
  assert.equal(beforeTimeout.contracts[0]?.action.kind, "lock"); // locks immediately, refund window not open yet
  dbA1.close();

  clock += 90_000; // 1.5 minutes -- past refundAfterMs (2min from an offer made ~now), before real time would allow
  const dbA2 = openTclkDatabase(dbPath);
  const stillLocked = await runTclkPayer({ db: dbA2, client, config, identity: payer, dryRun: false, log: noopLog, now: () => clock });
  assert.equal(stillLocked.contracts[0]?.action.kind, "none"); // test #14: not yet past refundAfterMs
  dbA2.close();

  clock += 60_000; // now past refundAfterMs
  const dbA3 = openTclkDatabase(dbPath);
  const afterTimeout = await runTclkPayer({ db: dbA3, client, config, identity: payer, dryRun: false, log: noopLog, now: () => clock });
  assert.equal(afterTimeout.contracts[0]?.posted?.kind, "refund"); // test #13
  dbA3.close();

  secretDb.close();
});

// Regression: a real run once logged "not accepted yet" for a finding it had
// JUST accepted moments earlier in the very same run. Root cause: phase 2 (advance
// already-accepted contracts) folded state against the `frames` snapshot read
// at the TOP of the run, taken before phase 1 (accept new offers) had posted
// anything -- so a contract accepted in phase 1 still looked "proposed" to
// phase 2 within that same run. Fixed by folding each freshly-posted accept
// into the in-memory `frames` array immediately (verifierWorker.ts).
test("e2e regression: accepting an offer and advancing it happen correctly within the SAME run (no stale 'not accepted yet')", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const findingId = "radar-20260902-samerun";
  seedFinding(dbPath, findingId);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const config = baseConfig({ dbPath, allowedPayerDid: payer.did });

  const db0 = openTclkDatabase(dbPath);
  await ensureTclkOffer(db0, client, config, payer, { findingId }, noopLog);
  db0.close();

  const secretDb = openSecretStore(tempPath("secrets.sqlite3"));
  const db1 = openTclkDatabase(dbPath);
  const summary = await runTclkVerifier({
    db: db1, secretDb, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m",
    dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified,
  });
  db1.close();
  secretDb.close();

  assert.equal(summary.acceptedCount, 1);
  const entriesForFinding = summary.contracts.filter((c) => c.findingId === findingId);
  // Phase 1 (accept) and phase 2 (advance) each report their own entry for
  // this finding -- that's expected. What must NOT happen is phase 2 folding
  // against a stale pre-accept snapshot: every entry must show "accepted"
  // (never "proposed"), and none may carry the stale reason.
  assert.ok(entriesForFinding.length >= 1);
  for (const entry of entriesForFinding) {
    assert.equal(entry.status, "accepted");
    assert.notEqual("reason" in entry.action ? entry.action.reason : undefined, "not accepted yet");
  }
  // And phase 2 specifically must now see it as "accepted, waiting for lock" --
  // not "proposed, not accepted yet".
  const phase2Entry = entriesForFinding.find((e) => e.action.kind === "none");
  assert.equal(phase2Entry?.action.kind === "none" ? phase2Entry.action.reason : undefined, "waiting for the payer to lock");
});

// Regression: a real run hit AbortError (a network timeout) writing the
// PaperRail note for ONE contract's lock, and that exception propagated all
// the way out of runTclkPayer -- aborting the whole batch before it ever got
// to the SECOND, unrelated contract that was also ready to lock. Fixed by
// isolating each contract's action in its own try/catch (payer.ts /
// verifierWorker.ts), same discipline mentions/run.ts and verifier/run.ts
// already use in their own per-item loops.
test("e2e regression: one contract's action failing does not abort the rest of the batch", async () => {
  const server = new FakeTechnocore();
  const payer = makeTestIdentity();
  const payee = makeTestIdentity();
  const dbPath = tempPath("mentions.sqlite3");
  const findingA = "radar-20260902-batchA";
  const findingB = "radar-20260902-batchB";
  seedFinding(dbPath, findingA, "a");
  seedFinding(dbPath, findingB, "b");

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const config = baseConfig({ dbPath, allowedPayerDid: payer.did });

  for (const findingId of [findingA, findingB]) {
    const db = openTclkDatabase(dbPath);
    await ensureTclkOffer(db, client, config, payer, { findingId }, noopLog);
    db.close();
  }

  const secretDb = openSecretStore(tempPath("secrets.sqlite3"));
  const dbB = openTclkDatabase(dbPath);
  await runTclkVerifier({
    db: dbB, secretDb, client, config, identity: payee, openAiApiKey: "k", verifierModel: "m",
    dryRun: false, log: noopLog, fetchArticleFn: mockFetchOk, analyzeFn: mockAnalyzeVerified,
  });
  dbB.close();
  secretDb.close();

  const { PaperRail: RealPaperRail, MemoryNoteStore, paperNote } = await import("@flop-labs/tclk");
  const contractA = (() => { const d = openTclkDatabase(dbPath); const r = getContractByFindingId(d, findingA)!; d.close(); return r; })();
  const faultyNs = paperNote(contractA.tclk_contract_id!).ns;

  // Wraps a real MemoryNoteStore, but throws (simulating a network timeout)
  // for exactly the note contract A's lock would write to.
  const inner = new MemoryNoteStore();
  const faultyNotes = {
    get: (ns: string, key: string) => inner.get(ns, key),
    set: (ns: string, key: string, value: string, condition?: { ifAbsent: true } | { if: string }) => {
      if (ns === faultyNs) throw new Error("AbortError: This operation was aborted");
      return inner.set(ns, key, value, condition);
    },
  };
  const rail = new RealPaperRail(faultyNotes);

  const dbA = openTclkDatabase(dbPath);
  const summary = await runTclkPayer({ db: dbA, client, config, identity: payer, dryRun: false, log: noopLog, rail: rail as never });
  dbA.close();

  const entryA = summary.contracts.find((c) => c.findingId === findingA)!;
  const entryB = summary.contracts.find((c) => c.findingId === findingB)!;
  assert.ok(entryA.error?.includes("AbortError")); // A's failure is reported, not swallowed silently
  assert.equal(entryA.posted, undefined);
  assert.equal(entryB.posted?.kind, "lock"); // B still got locked despite A's failure
});
