import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, upsertSource, insertSnapshot, insertExtractions } from "./database.js";
import { parseHtmlDocument } from "./normalize/html.js";
import { extractHtmlFlopDocument } from "./extract/index.js";
import { detectTeaserYellowpaperContradiction } from "./contradictions.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

function withDb(fn: (db: ReturnType<typeof openDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-contradictions-"));
  const db = openDatabase(join(dir, "t.sqlite3"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedTeaserSnapshot(db: ReturnType<typeof openDatabase>, fixtureName: string): void {
  upsertSource(db, { id: "teaser", name: "Teaser", url: "https://flop.finance/teaser/", kind: "html-flop", enabled: true });
  const { root } = parseHtmlDocument(fixture(fixtureName));
  const { items } = extractHtmlFlopDocument(root);
  const snapshotId = insertSnapshot(db, {
    sourceId: "teaser",
    fetchedAt: new Date().toISOString(),
    rawHash: "r",
    normalizedHash: "n",
    parseStatus: "ok",
    isBaseline: true,
  });
  insertExtractions(db, snapshotId, items);
}

test("contradictions: flags the teaser's own 'not yet ratified' disclosure and points to the Yellow Paper as normative", () => {
  withDb((db) => {
    seedTeaserSnapshot(db, "teaser-v1.html");
    const result = detectTeaserYellowpaperContradiction(db);
    assert.equal(result.contradicts, true);
    assert.match(result.note!, /Yellow Paper.*normative/);
    assert.match(result.teaserBannerText!, /not yet ratified/);
  });
});

test("contradictions: no teaser snapshot yet -> not flagged", () => {
  withDb((db) => {
    const result = detectTeaserYellowpaperContradiction(db);
    assert.equal(result.contradicts, false);
  });
});

test("contradictions: a teaser banner with no disclosure phrase is not flagged", () => {
  withDb((db) => {
    upsertSource(db, { id: "teaser", name: "Teaser", url: "https://flop.finance/teaser/", kind: "html-flop", enabled: true });
    const { root } = parseHtmlDocument('<title>Teaser</title><div class="draft-banner">Everything here matches the Yellow Paper exactly.</div>');
    const { items } = extractHtmlFlopDocument(root);
    const snapshotId = insertSnapshot(db, { sourceId: "teaser", fetchedAt: new Date().toISOString(), rawHash: "r", normalizedHash: "n", parseStatus: "ok", isBaseline: true });
    insertExtractions(db, snapshotId, items);

    const result = detectTeaserYellowpaperContradiction(db);
    assert.equal(result.contradicts, false);
  });
});
