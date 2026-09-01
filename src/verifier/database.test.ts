import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertDiscovered, markPublished as markMentionPublished, openDatabase as openMentionsDatabase } from "../mentions/database.js";
import type { Candidate } from "../mentions/types.js";
import {
  openDatabase,
  getPendingFindingsToVerify,
  getVerification,
  ensurePendingVerification,
  markAnalyzed,
  markPublished,
  markPublishFailed,
  markVerificationFailed,
  resetVerification,
} from "./database.js";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-verifier-test-"));
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

/** Seeds a published mention the way a real Radar run would, returning its finding_id. */
function seedPublishedMention(dbPath: string, overrides: Partial<Candidate> = {}): string {
  const db = openMentionsDatabase(dbPath);
  const id = insertDiscovered(db, sampleCandidate(overrides));
  markMentionPublished(db, id, "d-technocore-radar", "1", "A finding about Technocore.", "hash-of-content");
  const row = db.prepare(`SELECT finding_id FROM mentions WHERE id = ?`).get(id) as { finding_id: string };
  db.close();
  return row.finding_id;
}

test("migration: opening the verifier database never touches existing mentions rows", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);

  const db = openDatabase(dbPath); // verifier's own open, runs its migration on top
  const row = db.prepare(`SELECT * FROM mentions WHERE finding_id = ?`).get(findingId) as { status: string; finding: string };
  assert.equal(row.status, "published");
  assert.equal(row.finding, "A finding about Technocore.");

  // The new table exists and starts empty -- migration is additive only.
  const count = db.prepare(`SELECT COUNT(*) AS c FROM verifications`).get() as { c: number };
  assert.equal(count.c, 0);
  db.close();
});

test("selection: a published finding with no verification row is a candidate", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  const pending = getPendingFindingsToVerify(db, 10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].finding_id, findingId);
  db.close();
});

test("selection: a finding already verified or rejected is excluded", () => {
  const dbPath = tempDbPath();
  const verifiedId = seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/a", urlHash: "h-a" });
  const rejectedId = seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/b", urlHash: "h-b" });
  const db = openDatabase(dbPath);

  markAnalyzed(db, verifiedId, "VERIFIED", "matches", "did:key:verifier", "h1", "h1");
  markPublished(db, verifiedId, "VERIFIED", "d-technocore-radar", "10");

  markAnalyzed(db, rejectedId, "REJECTED", "does not match", "did:key:verifier", "h1", "h2");
  markPublished(db, rejectedId, "REJECTED", "d-technocore-radar", "11");

  assert.deepEqual(getPendingFindingsToVerify(db, 10), []);
  db.close();
});

test("selection: a non-published mention (still discovered) is never a candidate", () => {
  const dbPath = tempDbPath();
  const mdb = openMentionsDatabase(dbPath);
  insertDiscovered(mdb, sampleCandidate());
  mdb.close();

  const db = openDatabase(dbPath);
  assert.deepEqual(getPendingFindingsToVerify(db, 10), []);
  db.close();
});

test("selection: verification_failed and publish_failed findings are retried (stay in the candidate set)", () => {
  const dbPath = tempDbPath();
  const failedFetchId = seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/a", urlHash: "h-a" });
  const failedPublishId = seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/b", urlHash: "h-b" });
  const db = openDatabase(dbPath);

  markVerificationFailed(db, failedFetchId, "fetch timed out");
  markAnalyzed(db, failedPublishId, "VERIFIED", "matches", "did:key:verifier", "h1", "h1");
  markPublishFailed(db, failedPublishId, "network error");

  const pending = getPendingFindingsToVerify(db, 10).map((r) => r.finding_id);
  assert.deepEqual(new Set(pending), new Set([failedFetchId, failedPublishId]));
  db.close();
});

test("selection: respects the limit and orders oldest-discovered first", () => {
  const dbPath = tempDbPath();
  const first = seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/1", urlHash: "h1" });
  seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/2", urlHash: "h2" });
  seedPublishedMention(dbPath, { canonicalUrl: "https://example.com/3", urlHash: "h3" });

  const db = openDatabase(dbPath);
  const pending = getPendingFindingsToVerify(db, 1);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].finding_id, first);
  db.close();
});

test("ensurePendingVerification: idempotent -- a second call returns the same row untouched", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  const first = ensurePendingVerification(db, findingId);
  assert.equal(first.status, "pending");

  markAnalyzed(db, findingId, "VERIFIED", "matches", "did:key:verifier", "h1", "h1");
  const second = ensurePendingVerification(db, findingId);
  assert.equal(second.status, "publish_failed"); // not reset back to pending
  assert.equal(second.result, "VERIFIED");
  db.close();
});

test("state machine: analyzed -> published (verified)", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  ensurePendingVerification(db, findingId);
  markAnalyzed(db, findingId, "VERIFIED", "the content supports the claim", "did:key:verifierB", "orig-hash", "verify-hash");

  let row = getVerification(db, findingId)!;
  assert.equal(row.status, "publish_failed"); // analyzed but not yet posted
  assert.equal(row.result, "VERIFIED");
  assert.equal(row.reason, "the content supports the claim");
  assert.equal(row.verifier_did, "did:key:verifierB");
  assert.equal(row.original_content_hash, "orig-hash");
  assert.equal(row.verification_content_hash, "verify-hash");

  markPublished(db, findingId, "VERIFIED", "d-technocore-radar", "99");
  row = getVerification(db, findingId)!;
  assert.equal(row.status, "verified");
  assert.equal(row.technocore_room, "d-technocore-radar");
  assert.equal(row.technocore_message_id, "99");
  assert.ok(row.verified_at);
  db.close();
});

test("state machine: analyzed -> REJECTED published sets status 'rejected', not 'verified'", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  ensurePendingVerification(db, findingId);
  markAnalyzed(db, findingId, "REJECTED", "content does not support the claim", "did:key:verifierB", "orig-hash", "verify-hash");
  markPublished(db, findingId, "REJECTED", "d-technocore-radar", "100");

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "rejected");
  assert.equal(row.result, "REJECTED");
  db.close();
});

test("retry semantics: publish_failed keeps the analyzed result/reason so a retry can skip OpenAI", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  ensurePendingVerification(db, findingId);
  markAnalyzed(db, findingId, "VERIFIED", "matches", "did:key:verifierB", "orig-hash", "verify-hash");
  markPublishFailed(db, findingId, "ETIMEDOUT");

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "publish_failed");
  assert.equal(row.result, "VERIFIED"); // preserved, not lost
  assert.equal(row.reason, "matches"); // preserved
  assert.equal(row.error, "ETIMEDOUT");
  db.close();
});

test("retry semantics: verification_failed clears nothing usable -- result stays null so a retry redoes analysis", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  ensurePendingVerification(db, findingId);
  markVerificationFailed(db, findingId, "fetch failed: HTTP 500");

  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "verification_failed");
  assert.equal(row.result, null);
  assert.equal(row.error, "fetch failed: HTTP 500");
  db.close();
});

test("resetVerification: --force clears a finalized row back to a fresh pending state", () => {
  const dbPath = tempDbPath();
  const findingId = seedPublishedMention(dbPath);
  const db = openDatabase(dbPath);

  ensurePendingVerification(db, findingId);
  markAnalyzed(db, findingId, "VERIFIED", "matches", "did:key:verifierB", "orig-hash", "verify-hash");
  markPublished(db, findingId, "VERIFIED", "d-technocore-radar", "1");

  resetVerification(db, findingId);
  const row = getVerification(db, findingId)!;
  assert.equal(row.status, "pending");
  assert.equal(row.result, null);
  assert.equal(row.reason, null);
  assert.equal(row.technocore_message_id, null);
  db.close();
});
