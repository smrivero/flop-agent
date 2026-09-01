import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDiscovered, markPublished as markMentionPublished, openDatabase as openMentionsDatabase } from "../mentions/database.js";
import type { Candidate } from "../mentions/types.js";
import { openDatabase, getVerification } from "./database.js";
import { runVerifier, type VerifierRunSummary } from "./run.js";
import type { VerifierConfig } from "./config.js";
import type { VerifierIdentities } from "./identity.js";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-verifier-run-test-"));
  return join(dir, "mentions.sqlite3");
}

function sampleCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    canonicalUrl: "https://example.com/post",
    urlHash: "hash-1",
    originalUrl: "https://example.com/post",
    title: "A post",
    domain: "example.com",
    snippet: "snippet",
    searchQuery: "Technocore FLOP",
    searchProvider: "tavily",
    ...overrides,
  };
}

function seedPublishedMention(dbPath: string, finding: string, overrides: Partial<Candidate> = {}): string {
  const db = openMentionsDatabase(dbPath);
  const id = insertDiscovered(db, sampleCandidate(overrides));
  markMentionPublished(db, id, "d-technocore-radar", "1", finding, "original-content-hash");
  const row = db.prepare(`SELECT finding_id FROM mentions WHERE id = ?`).get(id) as { finding_id: string };
  db.close();
  return row.finding_id;
}

function baseConfig(dbPath: string, overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    verifierEnabled: true,
    verifierMaxPerRun: 2,
    verifierSampleRate: 1,
    verifierModel: "gpt-5-nano",
    openAiApiKey: "k",
    verifierIdentityPath: ".technocore/identityB.json",
    radarIdentityPath: ".technocore/identity.json",
    httpTimeoutMs: 15000,
    maxRetries: 0,
    maxContentChars: 12000,
    dbPath,
    lockPath: "/dev/null",
    ...overrides,
  };
}

const fakeIdentities: VerifierIdentities = {
  radarDid: "did:key:z6MkRadarRadarRadarRadarRadarRadarRadarRad",
  verifier: {
    did: "did:key:z6MkVerifierVerifierVerifierVerifierVerif",
    sign: (msg: string) => `fake-signature-over-${msg}`.slice(0, 90),
  },
};

function noopLog(): void {}

test("run: a published finding with no verification is selected, fetched, analyzed, and published as VERIFIED", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "The page describes agents coordinating over Technocore.");
  const db = openDatabase(dbPath);
  const sent: { room: string; text: string }[] = [];

  const summary = await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async (room, text) => { sent.push({ room, text }); return { seq: 7 }; },
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>Agents coordinate over Technocore protocol here.</body></html>",
    analyzeFn: async () => ({ result: "VERIFIED", reason: "The fetched content confirms agents coordinating over Technocore." }),
  });

  assert.equal(summary.candidates, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.rejected, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, "d-technocore-radar");
  assert.match(sent[0].text, /Result: VERIFIED/);

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "verified");
  assert.equal(row.verifier_did, fakeIdentities.verifier.did);
  assert.equal(row.technocore_message_id, "7");
  db.close();
});

test("run: REJECTED verdict is published and persisted distinctly from VERIFIED", async () => {
  const dbPath = tempDbPath();
  seedPublishedMention(dbPath, "The page claims Technocore supports quantum signatures.");
  const db = openDatabase(dbPath);
  const sent: string[] = [];

  const summary = await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async (_room, text) => { sent.push(text); return { seq: 1 }; },
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>Technocore uses Ed25519 signatures, nothing about quantum.</body></html>",
    analyzeFn: async () => ({ result: "REJECTED", reason: "The content describes Ed25519 signatures, not quantum signatures." }),
  });

  assert.equal(summary.rejected, 1);
  assert.equal(summary.verified, 0);
  assert.match(sent[0], /Result: REJECTED/);
  assert.match(sent[0], /quantum/);
});

test("run: an already-VERIFIED finding is not re-selected on a later run", async () => {
  const dbPath = tempDbPath();
  seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);
  const config = baseConfig(dbPath);
  const deps = {
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => ({ result: "VERIFIED" as const, reason: "ok" }),
  };

  const first = await runVerifier({ config, db, ...deps });
  assert.equal(first.candidates, 1);

  const second = await runVerifier({ config, db, ...deps });
  assert.equal(second.candidates, 0);
  db.close();
});

test("run: VERIFIER_MAX_PER_RUN caps how many findings are processed in one pass", async () => {
  const dbPath = tempDbPath();
  for (let i = 0; i < 5; i++) {
    seedPublishedMention(dbPath, `Finding ${i}`, { canonicalUrl: `https://example.com/${i}`, urlHash: `h${i}` });
  }
  const db = openDatabase(dbPath);

  const summary = await runVerifier({
    config: baseConfig(dbPath, { verifierMaxPerRun: 2 }),
    db,
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => ({ result: "VERIFIED", reason: "ok" }),
  });

  assert.equal(summary.candidates, 2);
  db.close();
});

test("run: VERIFIER_SAMPLE_RATE=0 selects nothing", async () => {
  const dbPath = tempDbPath();
  seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);

  const summary = await runVerifier({
    config: baseConfig(dbPath, { verifierSampleRate: 0 }),
    db,
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => ({ result: "VERIFIED", reason: "ok" }),
  });

  assert.equal(summary.candidates, 0);
  db.close();
});

test("run: independent fetch failure marks verification_failed and never reaches REJECTED", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);
  let analyzeCalls = 0;

  const summary = await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => null, // simulates a failed independent fetch
    analyzeFn: async () => { analyzeCalls++; return { result: "VERIFIED", reason: "should never be called" }; },
  });

  assert.equal(summary.verificationFailed, 1);
  assert.equal(summary.verified, 0);
  assert.equal(summary.rejected, 0);
  assert.equal(analyzeCalls, 0); // OpenAI is never spent on a failed fetch

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "verification_failed");
  assert.equal(row.result, null);
  db.close();
});

test("run: an OpenAI analysis failure marks verification_failed, not REJECTED", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);

  await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => { throw new Error("OpenAI request failed: HTTP 500"); },
  });

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "verification_failed");
  assert.match(row.error!, /HTTP 500/);
  db.close();
});

test("retry: a publish_failed finding retries only the publish -- OpenAI is never called again", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);
  let analyzeCalls = 0;
  let sendCalls = 0;

  const failingConfig = baseConfig(dbPath);
  const analyzeFn = async () => { analyzeCalls++; return { result: "VERIFIED" as const, reason: "matches" }; };
  const fetchArticleFn = async () => "<html><body>content</body></html>";

  // First run: analysis succeeds, but the "publish" fails.
  await runVerifier({
    config: failingConfig,
    db,
    identities: fakeIdentities,
    send: async () => { sendCalls++; throw new Error("ETIMEDOUT"); },
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn,
    analyzeFn,
  });
  assert.equal(analyzeCalls, 1);
  assert.equal(sendCalls, 1);
  let row = getVerification(db, findingId)!;
  assert.equal(row.status, "publish_failed");
  assert.equal(row.result, "VERIFIED");

  // Second run: publish succeeds this time -- analyze must NOT be called again.
  const sent: string[] = [];
  const summary = await runVerifier({
    config: failingConfig,
    db,
    identities: fakeIdentities,
    send: async (_room, text) => { sendCalls++; sent.push(text); return { seq: 55 }; },
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn,
    analyzeFn,
  });

  assert.equal(analyzeCalls, 1); // unchanged -- no second OpenAI call
  assert.equal(sendCalls, 2);
  assert.equal(summary.verified, 1);
  assert.match(sent[0], /Result: VERIFIED/);
  row = getVerification(db, findingId)!;
  assert.equal(row.status, "verified");
  assert.equal(row.technocore_message_id, "55");
  db.close();
});

test("content hash: both original and freshly-fetched hashes are recorded, mismatch does not force REJECTED", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "A finding."); // seeded with content_hash = 'original-content-hash'
  const db = openDatabase(dbPath);

  await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>completely different content now, page changed</body></html>",
    // The LLM's judgment is what decides, independent of whether hashes match.
    analyzeFn: async () => ({ result: "VERIFIED", reason: "still supports the claim despite a reworded page" }),
  });

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "verified");
  assert.equal(row.original_content_hash, "original-content-hash");
  assert.ok(row.verification_content_hash);
  assert.notEqual(row.verification_content_hash, row.original_content_hash);
  db.close();
});

test("dry-run: never calls send and never persists a terminal status", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);
  let sendCalls = 0;

  const summary = await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async () => { sendCalls++; return { seq: 1 }; },
    dryRun: true,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => ({ result: "VERIFIED", reason: "ok" }),
  });

  assert.equal(sendCalls, 0);
  assert.equal(summary.skippedDryRun, 1);
  assert.equal(summary.verified, 1);

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "publish_failed"); // analyzed, never actually posted
  assert.equal(row.technocore_message_id, null);
  db.close();
});

test("manual --finding: verifies exactly the requested finding_id, ignoring VERIFIER_MAX_PER_RUN", async () => {
  const dbPath = tempDbPath();
  const targetId = seedPublishedMention(dbPath, "Target finding.", { canonicalUrl: "https://example.com/target", urlHash: "h-target" });
  seedPublishedMention(dbPath, "Other finding.", { canonicalUrl: "https://example.com/other", urlHash: "h-other" });
  const db = openDatabase(dbPath);

  const summary = await runVerifier({
    config: baseConfig(dbPath, { verifierMaxPerRun: 0 }),
    db,
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    onlyFindingId: targetId,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => ({ result: "VERIFIED", reason: "ok" }),
  });

  assert.equal(summary.candidates, 1);
  const row = getVerification(db, targetId)!;
  assert.equal(row.status, "verified");

  const otherPending = db.prepare(`SELECT COUNT(*) AS c FROM verifications WHERE finding_id != ?`).get(targetId) as { c: number };
  assert.equal(otherPending.c, 0); // the other finding was never touched
  db.close();
});

test("--force: re-verifies a finding whose verification is already finalized", async () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);
  let analyzeCalls = 0;

  const deps = {
    identities: fakeIdentities,
    send: async () => ({ seq: 1 }),
    dryRun: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>content</body></html>",
    analyzeFn: async () => { analyzeCalls++; return { result: "VERIFIED" as const, reason: "ok" }; },
  };

  await runVerifier({ config: baseConfig(dbPath), db, onlyFindingId: findingId, force: false, ...deps });
  assert.equal(analyzeCalls, 1);

  // Without --force, a second run against the same finding_id would find it
  // already finalized; --force explicitly re-runs it anyway.
  await runVerifier({ config: baseConfig(dbPath), db, onlyFindingId: findingId, force: true, ...deps });
  assert.equal(analyzeCalls, 2);
  db.close();
});

test("mock: an in-memory sender lets the whole pipeline run with zero real network calls", async () => {
  const dbPath = tempDbPath();
  seedPublishedMention(dbPath, "A finding.");
  const db = openDatabase(dbPath);
  const mockSent: { room: string; text: string }[] = [];

  const summary: VerifierRunSummary = await runVerifier({
    config: baseConfig(dbPath),
    db,
    identities: fakeIdentities,
    send: async (room, text) => { mockSent.push({ room, text }); return { seq: 999 }; }, // stands in for --mock
    dryRun: false,
    force: false,
    maxContentChars: 12000,
    log: noopLog,
    fetchArticleFn: async () => "<html><body>mock content</body></html>", // stands in for a real fetch
    analyzeFn: async () => ({ result: "VERIFIED", reason: "mock reason" }), // stands in for a real OpenAI call
  });

  assert.equal(summary.verified, 1);
  assert.equal(mockSent.length, 1);
  db.close();
});
