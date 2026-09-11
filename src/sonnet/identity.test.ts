import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentitySeed } from "../identity.js";
import { loadSonnetIdentity, SonnetIdentityError } from "./identity.js";

function writeIdentityFile(dir: string, name: string, seed: { did: string; seedHex: string }): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sonnet-identity-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSonnetIdentity: loads Agent A via TECHNOCORE_IDENTITY_PATH when no Agent B conflict exists", () => {
  withTmpDir((dir) => {
    const a = generateIdentitySeed();
    const path = writeIdentityFile(dir, "agent-a.json", a);
    const result = loadSonnetIdentity({ TECHNOCORE_IDENTITY_PATH: path });
    assert.equal(result.did, a.did);
  });
});

test("loadSonnetIdentity: does not conflict when VERIFIER_IDENTITY_PATH points at a genuinely different identity", () => {
  withTmpDir((dir) => {
    const a = generateIdentitySeed();
    const b = generateIdentitySeed();
    const aPath = writeIdentityFile(dir, "agent-a.json", a);
    const bPath = writeIdentityFile(dir, "agent-b.json", b);
    const result = loadSonnetIdentity({ TECHNOCORE_IDENTITY_PATH: aPath, VERIFIER_IDENTITY_PATH: bPath });
    assert.equal(result.did, a.did);
  });
});

test("loadSonnetIdentity: refuses when TECHNOCORE_IDENTITY_PATH and VERIFIER_IDENTITY_PATH resolve to the same DID", () => {
  withTmpDir((dir) => {
    const a = generateIdentitySeed();
    const aPath = writeIdentityFile(dir, "agent-a.json", a);
    const samePath = writeIdentityFile(dir, "agent-a-copy.json", a); // same seed -> same DID
    assert.throws(
      () => loadSonnetIdentity({ TECHNOCORE_IDENTITY_PATH: aPath, VERIFIER_IDENTITY_PATH: samePath }),
      SonnetIdentityError,
    );
  });
});

test("loadSonnetIdentity: a missing/nonexistent VERIFIER_IDENTITY_PATH is not treated as a conflict", () => {
  withTmpDir((dir) => {
    const a = generateIdentitySeed();
    const aPath = writeIdentityFile(dir, "agent-a.json", a);
    const result = loadSonnetIdentity({ TECHNOCORE_IDENTITY_PATH: aPath, VERIFIER_IDENTITY_PATH: join(dir, "does-not-exist.json") });
    assert.equal(result.did, a.did);
  });
});
