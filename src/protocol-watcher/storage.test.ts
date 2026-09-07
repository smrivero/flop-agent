import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeContent, sweepOrphanedContent } from "./storage.js";
import { sha256Hex } from "./hash.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-storage-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("storage: storeContent dedups identical content under the same hash/path", () => {
  withTempDir((dir) => {
    const hash = sha256Hex("same content");
    const pathA = storeContent(dir, hash, "raw", "same content");
    const pathB = storeContent(dir, hash, "raw", "same content");
    assert.equal(pathA, pathB);
    assert.ok(existsSync(pathA));
  });
});

test("storage: sweepOrphanedContent keeps referenced files regardless of age", () => {
  withTempDir((dir) => {
    const hash = sha256Hex("kept");
    const path = storeContent(dir, hash, "raw", "kept");
    utimesSync(path, new Date(0), new Date(0)); // ancient mtime

    const result = sweepOrphanedContent(dir, new Set([hash]), 1);
    assert.deepEqual(result.deletedPaths, []);
    assert.ok(existsSync(path));
  });
});

test("storage: sweepOrphanedContent deletes old, unreferenced files only", () => {
  withTempDir((dir) => {
    const oldHash = sha256Hex("old-orphan");
    const oldPath = storeContent(dir, oldHash, "raw", "old-orphan");
    utimesSync(oldPath, new Date(0), new Date(0));

    const freshHash = sha256Hex("fresh-orphan");
    const freshPath = storeContent(dir, freshHash, "raw", "fresh-orphan");

    const result = sweepOrphanedContent(dir, new Set(), 1);
    assert.deepEqual(result.deletedPaths, [oldPath]);
    assert.ok(!existsSync(oldPath));
    assert.ok(existsSync(freshPath), "an unreferenced but recent file must survive retention");
  });
});
