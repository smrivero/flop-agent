import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  openDatabase,
  isKnownUrl,
  insertDiscovered,
  markPublished,
  markRejected,
  markPublishFailed,
  getMention,
  getFindingByFindingId,
  getPendingBacklog,
  peekQueryBatch,
  advanceQueryRotation,
} from "./database.js";
import { generateFindingId } from "./finding.js";
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
    searchQuery: "Technocore FLOP",
    searchProvider: "tavily",
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
  markPublished(db, id, "d-technocore-radar", "42", "A page discusses Technocore.", "abc123");

  const row = getMention(db, id);
  assert.equal(row?.status, "published");
  assert.equal(row?.technocore_room, "d-technocore-radar");
  assert.equal(row?.technocore_message_id, "42");
  assert.equal(row?.finding, "A page discusses Technocore.");
  assert.equal(row?.content_hash, "abc123");
  assert.ok(row?.published_at);
  assert.ok(row?.checked_at);

  // The dedup check is what a real run relies on to never re-publish this URL.
  assert.equal(isKnownUrl(db, "https://example.com/post", "hash-1"), true);
  db.close();
});

test("database: rejected mentions record a reason and are still considered known (not re-processed)", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate());
  markRejected(db, id, "not related per OpenAI (Technocore Radar)", "def456");
  const row = getMention(db, id);
  assert.equal(row?.status, "rejected");
  assert.equal(row?.error, "not related per OpenAI (Technocore Radar)");
  assert.equal(row?.content_hash, "def456");
  assert.equal(isKnownUrl(db, "https://example.com/post", "hash-1"), true);
  db.close();
});

test("database: reproducibility fields (search_query, search_provider, discovered_at) are persisted", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate({ searchQuery: "Technocore inference", searchProvider: "searxng" }));
  const row = getMention(db, id);
  assert.equal(row?.search_query, "Technocore inference");
  assert.equal(row?.search_provider, "searxng");
  assert.ok(row?.discovered_at);
  db.close();
});

// -- findings ---------------------------------------------------------------

test("finding_id: assigned automatically on insert, matches radar-YYYYMMDD-<hash> shape", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate());
  const row = getMention(db, id);
  assert.match(row!.finding_id!, /^radar-\d{8}-[0-9a-f]{6}$/);
  db.close();
});

test("finding_id: stable generation -- the same (URL, date) always produces the same finding_id", () => {
  const date = new Date("2026-09-01T12:00:00Z");
  const a = generateFindingId("https://example.com/post", date);
  const b = generateFindingId("https://example.com/post", date);
  assert.equal(a, b);
});

test("finding_id: the hash component is a pure function of the canonical URL -- same URL, same hash component regardless of date", () => {
  const url = "https://example.com/post";
  const idJan = generateFindingId(url, new Date("2026-01-01T00:00:00Z"));
  const idSep = generateFindingId(url, new Date("2026-09-01T00:00:00Z"));
  const hashOf = (id: string) => id.split("-")[2];
  assert.equal(hashOf(idJan), hashOf(idSep));
  assert.notEqual(idJan, idSep); // the date component still differs
});

test("finding_id: different URLs produce different finding_ids", () => {
  const date = new Date("2026-09-01T00:00:00Z");
  const a = generateFindingId("https://example.com/post-a", date);
  const b = generateFindingId("https://example.com/post-b", date);
  assert.notEqual(a, b);
});

test("getFindingByFindingId: retrieves a stored finding by its public ID -- this is Bot B's entry point", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate());
  const inserted = getMention(db, id);
  markPublished(db, id, "d-technocore-radar", "7", "The page mentions Technocore as an agent protocol.", "hashvalue123");

  const finding = getFindingByFindingId(db, inserted!.finding_id!);
  assert.ok(finding);
  assert.equal(finding!.canonical_url, "https://example.com/post");
  assert.equal(finding!.finding, "The page mentions Technocore as an agent protocol.");
  assert.equal(finding!.content_hash, "hashvalue123");
  assert.equal(finding!.status, "published");
});

test("getFindingByFindingId: returns undefined for an unknown ID", () => {
  const db = openDatabase(tempDbPath());
  assert.equal(getFindingByFindingId(db, "radar-20260101-ffffff"), undefined);
  db.close();
});

test("retry: a publish_failed finding keeps the SAME finding_id and stays in the retryable backlog", () => {
  const db = openDatabase(tempDbPath());
  const id = insertDiscovered(db, sampleCandidate());
  const originalFindingId = getMention(db, id)!.finding_id;

  markPublishFailed(db, id, "Technocore request failed: 503", "A finding generated before the write failed.", "hash1");

  const afterFailure = getMention(db, id);
  assert.equal(afterFailure!.status, "publish_failed");
  assert.equal(afterFailure!.finding_id, originalFindingId); // unchanged
  assert.equal(afterFailure!.finding, "A finding generated before the write failed."); // kept, not regenerated

  const backlog = getPendingBacklog(db, 10);
  assert.equal(backlog.length, 1);
  assert.equal(backlog[0].id, id);
  assert.equal(backlog[0].finding_id, originalFindingId);

  // Once it succeeds, it leaves the retryable backlog for good.
  markPublished(db, id, "d-technocore-radar", "9", afterFailure!.finding, afterFailure!.content_hash);
  assert.equal(getPendingBacklog(db, 10).length, 0);
  assert.equal(getMention(db, id)!.finding_id, originalFindingId);
  db.close();
});

test("backlog: discovered AND publish_failed are both retryable; rejected/published/analysis_failed are not", () => {
  const db = openDatabase(tempDbPath());
  const discovered = insertDiscovered(db, sampleCandidate({ canonicalUrl: "https://example.com/1", urlHash: "h1" }));
  const failed = insertDiscovered(db, sampleCandidate({ canonicalUrl: "https://example.com/2", urlHash: "h2" }));
  const rejected = insertDiscovered(db, sampleCandidate({ canonicalUrl: "https://example.com/3", urlHash: "h3" }));
  const published = insertDiscovered(db, sampleCandidate({ canonicalUrl: "https://example.com/4", urlHash: "h4" }));

  markPublishFailed(db, failed, "err", null, null);
  markRejected(db, rejected, "not related", null);
  markPublished(db, published, "d-technocore-radar", "1", null, null);

  const backlogIds = getPendingBacklog(db, 10).map((r) => r.id).sort();
  assert.deepEqual(backlogIds, [discovered, failed].sort());
  db.close();
});

// -- query rotation -------------------------------------------------------------

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

// -- migration --------------------------------------------------------------

test("migration: an existing pre-finding_id database gets backfilled without losing history", () => {
  const path = tempDbPath();

  // Simulate the OLD schema (before this change) with one historical row, the
  // way an existing deployment's database actually looks.
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_url TEXT NOT NULL UNIQUE,
        url_hash TEXT NOT NULL UNIQUE,
        original_url TEXT,
        title TEXT,
        domain TEXT,
        snippet TEXT,
        published_date TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT,
        technocore_room TEXT,
        technocore_message_id TEXT,
        summary TEXT,
        status TEXT NOT NULL,
        error TEXT
    );
  `);
  raw.prepare(
    `INSERT INTO mentions (canonical_url, url_hash, title, domain, discovered_at, status, summary, technocore_room, technocore_message_id)
     VALUES (?, ?, ?, ?, ?, 'published', ?, 'd-technocore-links', '55')`,
  ).run("https://old-example.com/historical-post", "oldhash1", "An old historical finding", "old-example.com", "2026-08-01T00:00:00.000Z", "Old summary text, pre-migration.");
  raw.close();

  // Now open it through the real migration path.
  const db = openDatabase(path);
  const row = db.prepare(`SELECT * FROM mentions WHERE canonical_url = ?`).get("https://old-example.com/historical-post") as {
    finding_id: string;
    finding: string;
    status: string;
    technocore_message_id: string;
  };

  // History preserved...
  assert.equal(row.status, "published");
  assert.equal(row.finding, "Old summary text, pre-migration."); // renamed column, same data
  assert.equal(row.technocore_message_id, "55");
  // ...and a valid finding_id was backfilled, deterministically.
  assert.match(row.finding_id, /^radar-20260801-[0-9a-f]{6}$/);
  db.close();
});
