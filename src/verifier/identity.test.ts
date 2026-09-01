import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentitySeed } from "../identity.js";
import { loadVerifierIdentities, SameDidError } from "./identity.js";
import type { VerifierConfig } from "./config.js";

function writeIdentity(dir: string, name: string, seed: { did: string; seedHex: string }): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

function baseConfig(radarPath: string, verifierPath: string): VerifierConfig {
  return {
    verifierEnabled: true,
    verifierMaxPerRun: 2,
    verifierSampleRate: 1,
    verifierModel: "gpt-5-nano",
    openAiApiKey: "k",
    verifierIdentityPath: verifierPath,
    radarIdentityPath: radarPath,
    httpTimeoutMs: 15000,
    maxRetries: 2,
    maxContentChars: 12000,
    dbPath: ":memory:",
    lockPath: "/dev/null",
  };
}

test("identity: distinct identity files resolve to distinct DIDs and both load correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-verifier-identity-"));
  const radarSeed = generateIdentitySeed();
  const verifierSeed = generateIdentitySeed();
  const radarPath = writeIdentity(dir, "identity.json", radarSeed);
  const verifierPath = writeIdentity(dir, "identityB.json", verifierSeed);

  const identities = loadVerifierIdentities(baseConfig(radarPath, verifierPath));

  assert.equal(identities.radarDid, radarSeed.did);
  assert.equal(identities.verifier.did, verifierSeed.did);
  assert.notEqual(identities.radarDid, identities.verifier.did);

  // The verifier's signer genuinely works and signs as its own DID, not Radar's.
  const sig = identities.verifier.sign("some-room|1|hello");
  assert.match(sig, /^[A-Za-z0-9_-]{86}$/);
});

test("identity: pointing both paths at the same identity file aborts with the exact safety message", () => {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-verifier-identity-"));
  const seed = generateIdentitySeed();
  const path = writeIdentity(dir, "identity.json", seed);

  assert.throws(
    () => loadVerifierIdentities(baseConfig(path, path)),
    (err: unknown) => {
      assert.ok(err instanceof SameDidError);
      assert.equal(
        err.message,
        "[verifier] ERROR: Radar and Verifier resolve to the same DID. " +
          `Both ${path} and ${path} sign as ${seed.did}. ` +
          "Refusing to publish -- this would let Radar verify its own work.",
      );
      return true;
    },
  );
});

test("identity: two DIFFERENT files holding the same underlying key still abort (same DID, not same path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-verifier-identity-"));
  const seed = generateIdentitySeed();
  const radarPath = writeIdentity(dir, "identity.json", seed);
  const verifierPath = writeIdentity(dir, "identityB.json", seed); // same seed, different file

  assert.throws(() => loadVerifierIdentities(baseConfig(radarPath, verifierPath)), SameDidError);
});

test("identity: a missing identity file still throws (IdentityError propagates, not swallowed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-verifier-identity-"));
  const verifierSeed = generateIdentitySeed();
  const verifierPath = writeIdentity(dir, "identityB.json", verifierSeed);
  const missingRadarPath = join(dir, "does-not-exist.json");

  assert.throws(() => loadVerifierIdentities(baseConfig(missingRadarPath, verifierPath)), /no identity file at/);
});
