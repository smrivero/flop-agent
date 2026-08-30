import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  isKnownUrl,
  insertDiscovered,
  markPublished,
  markRejected,
  getMention,
  peekQueryBatch,
  advanceQueryRotation,
} from "./database.js";
import type { Candidate } from "./types.js";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-mentions-test-"));
  return join(dir, "mentions.sqlite3");
}

function sampleCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    canonicalUrl: "https://example.com/post",
    urlHash: "hash-1",
    originalUrl: "https://example.com/post?utm_source=x",
    title: "A post",
    domain: "example.com",
    snippet: "snippet",
    publishedDate: "2026-08-20",
    ...overrides,
  };
}

test("database: a freshly discovered URL is not known", () => {
  const db = openDatabase(tempDbPath());
  assert.equal(isKnownUrl(db, "https://example.com/post", "hash-1"), false);
  db.close();
});

test("database: an inserted URL is known by canonical_url or by url_hash", () => {
  const db = openDatabase(tempDbPath());
  insertDiscovered(db, sampleCandidate());
  assert.equal(isKnownUrl(db, "https://example.com/post", "some-other-hash"), true);
  assert.equal(isKnownUrl(db, "https://example.com/different-post", "hash-1"), true);
  db.close();
});

test("database: publishing a mention never publishes a URL already marked published twice over", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate());
  markPublished(db, id, "d-technocore-links", "42", null);

  const row = getMention(db, id);
  assert.equal(row?.status, "published");
  assert.equal(row?.technocore_room, "d-technocore-links");
  assert.equal(row?.technocore_message_id, "42");

  // The dedup check is what a real run relies on to never re-publish this URL.
  assert.equal(isKnownUrl(db, "https://example.com/post", "hash-1"), true);
  db.close();
});

test("database: rejected mentions record a reason and are still considered known (not re-processed)", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate());
  markRejected(db, id, "not relevant per OpenAI");
  const row = getMention(db, id);
  assert.equal(row?.status, "rejected");
  assert.equal(row?.error, "not relevant per OpenAI");
  assert.equal(isKnownUrl(db, "https://example.com/post", "hash-1"), true);
  db.close();
});

test("query rotation: first peek starts at index 0", () => {
  const db = openDatabase(tempDbPath());
  const queries = ["a", "b", "c", "d", "e"];
  assert.deepEqual(peekQueryBatch(db, queries, 2), ["a", "b"]);
  db.close();
});

test("query rotation: advancing moves the next peek forward, matching the worked example", () => {
  const db = openDatabase(tempDbPath());
  const queries = ["Technocore FLOP", "technocore.chat", "Technocore AI agents", "FLOP Labs Technocore", "Technocore inference"];

  assert.deepEqual(peekQueryBatch(db, queries, 2), ["Technocore FLOP", "technocore.chat"]);
  advanceQueryRotation(db, queries, 2);

  assert.deepEqual(peekQueryBatch(db, queries, 2), ["Technocore AI agents", "FLOP Labs Technocore"]);
  advanceQueryRotation(db, queries, 2);

  assert.deepEqual(peekQueryBatch(db, queries, 2), ["Technocore inference", "Technocore FLOP"]); // wraps around
  db.close();
});

test("query rotation: persists across a fresh connection to the same file (cron continuing where it left off)", () => {
  const path = tempDbPath();
  const queries = ["a", "b", "c"];

  const db1 = openDatabase(path);
  advanceQueryRotation(db1, queries, 2);
  db1.close();

  const db2 = openDatabase(path);
  assert.deepEqual(peekQueryBatch(db2, queries, 2), ["c", "a"]);
  db2.close();
});

test("query rotation: QUERIES_PER_RUN=1 advances by exactly one", () => {
  const db = openDatabase(tempDbPath());
  const queries = ["a", "b", "c"];
  assert.deepEqual(peekQueryBatch(db, queries, 1), ["a"]);
  advanceQueryRotation(db, queries, 1);
  assert.deepEqual(peekQueryBatch(db, queries, 1), ["b"]);
  db.close();
});
