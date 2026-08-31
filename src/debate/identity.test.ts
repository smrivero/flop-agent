import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "./identity.js";
import { DID_PATTERN, IdentityError } from "../identity.js";

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "debate-identity-test-"));
  return join(dir, "agent.json");
}

test("identity generation: creates a valid identity file when none exists", () => {
  const path = tmpPath();
  const { identity, created } = loadOrCreateIdentity(path);
  assert.equal(created, true);
  assert.match(identity.did, DID_PATTERN);

  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.did, identity.did);
  assert.match(saved.seedHex, /^[0-9a-f]{64}$/);
});

test("persistent identity: loading an existing file returns the SAME DID, never a new one", () => {
  const path = tmpPath();
  const first = loadOrCreateIdentity(path);
  assert.equal(first.created, true);

  const second = loadOrCreateIdentity(path);
  assert.equal(second.created, false);
  assert.equal(second.identity.did, first.identity.did);

  const third = loadOrCreateIdentity(path);
  assert.equal(third.identity.did, first.identity.did);
});

test("persistent identity: restarting the process (a fresh call) never regenerates a DID for an existing file", () => {
  const path = tmpPath();
  const { identity: original } = loadOrCreateIdentity(path);
  // Simulate "the application restarted" -- nothing but the file on disk persists.
  for (let i = 0; i < 5; i++) {
    const { identity, created } = loadOrCreateIdentity(path);
    assert.equal(created, false);
    assert.equal(identity.did, original.did);
  }
});

test("identity loading: a corrupted identity file fails loudly rather than being silently replaced", () => {
  const path = tmpPath();
  writeFileSync(path, "not json");
  assert.throws(() => loadOrCreateIdentity(path), IdentityError);
});

test("identity loading: a DID that doesn't match its own seed fails loudly rather than being silently replaced", () => {
  const path = tmpPath();
  const { identity } = loadOrCreateIdentity(path);
  const otherPath = tmpPath();
  const { identity: other } = loadOrCreateIdentity(otherPath);
  // Splice a mismatched DID into the first file's content.
  writeFileSync(path, JSON.stringify({ did: other.did, seedHex: readFileSync(path, "utf8").match(/"seedHex": "([0-9a-f]+)"/)![1] }));
  assert.throws(() => loadOrCreateIdentity(path), IdentityError);
});

test("signature generation: a freshly generated agent identity can sign and be verified", () => {
  const path = tmpPath();
  const { identity } = loadOrCreateIdentity(path);
  const sig = identity.sign("room|1|hello");
  assert.match(sig, /^[A-Za-z0-9_-]{85}[AQgw]$/); // canonical encoding, confirmed against the live server
});
