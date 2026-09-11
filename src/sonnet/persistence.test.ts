import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic, PersistenceError } from "./persistence.js";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sonnet-persistence-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeJsonFileAtomic + readJsonFile: round-trips a value exactly", () => {
  withTmpDir((dir) => {
    const path = join(dir, "nested", "state.json");
    const value = { a: 1, b: ["x", "y"], c: { d: true } };
    writeJsonFileAtomic(path, value);
    assert.deepEqual(readJsonFile(path), value);
  });
});

test("writeJsonFileAtomic: leaves no temp file behind after a successful write", () => {
  withTmpDir((dir) => {
    writeJsonFileAtomic(join(dir, "state.json"), { ok: true });
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ["state.json"]);
  });
});

test("readJsonFile: returns undefined for a missing file rather than throwing", () => {
  withTmpDir((dir) => {
    assert.equal(readJsonFile(join(dir, "missing.json")), undefined);
  });
});

test("readJsonFile: throws PersistenceError for a file that exists but isn't valid JSON", () => {
  withTmpDir((dir) => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not valid json");
    assert.throws(() => readJsonFile(path), PersistenceError);
  });
});

test("writeJsonFileAtomic: a second write fully replaces the first (no partial merge)", () => {
  withTmpDir((dir) => {
    const path = join(dir, "state.json");
    writeJsonFileAtomic(path, { version: 1, extra: "keep-me-out" });
    writeJsonFileAtomic(path, { version: 2 });
    assert.deepEqual(readJsonFile(path), { version: 2 });
  });
});
