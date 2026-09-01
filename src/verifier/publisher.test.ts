import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { didFromPublicKey, type TechnocoreIdentity } from "../identity.js";
import { createTechnocoreVerifierSender, formatVerificationMessage } from "./publisher.js";

/** A real, self-consistent identity (genuine Ed25519 keypair, correctly
 * derived DID) -- sendSignedMessage verifies its own signature locally
 * before sending, so a fake DID/signature pair would fail before any
 * request is even built. Same construction as debate/testUtils.ts. */
function makeIdentity(): TechnocoreIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const did = didFromPublicKey(publicKeyBytes);
  return {
    did,
    sign: (message: string) => ed25519Sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

test("formatVerificationMessage: matches the documented VERIFIED/REJECTED template", () => {
  const text = formatVerificationMessage(
    { findingId: "radar-20260901-abc123", canonicalUrl: "https://example.com/article", originalFinding: "The page mentions Technocore." },
    "VERIFIED",
    "The fetched content confirms the claim.",
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "Technocore Verifier");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Finding: radar-20260901-abc123");
  assert.equal(lines[3], "Result: VERIFIED");
  assert.equal(lines[4], "");
  assert.equal(lines[5], "Original finding:");
  assert.equal(lines[6], "The page mentions Technocore.");
  assert.equal(lines[7], "");
  assert.equal(lines[8], "Reason:");
  assert.equal(lines[9], "The fetched content confirms the claim.");
  assert.equal(lines[10], "");
  assert.equal(lines[11], "Source:");
  assert.equal(lines[12], "https://example.com/article");
});

test("SECURITY: createTechnocoreVerifierSender signs with the identity it was given -- never falls back to loadIdentity()", async () => {
  const verifierIdentity = makeIdentity();

  // Point TECHNOCORE_IDENTITY_PATH (identity.json's default lookup) at a file
  // that does not exist. If createTechnocoreVerifierSender ever fell back to
  // loadIdentity() -- i.e. omitted `{ identity }` -- this would throw
  // IdentityError ("no identity file at ...") before any request is even
  // built, proving the bug. It must NOT throw here.
  const previous = process.env.TECHNOCORE_IDENTITY_PATH;
  process.env.TECHNOCORE_IDENTITY_PATH = "/nonexistent/path/identity.json";

  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ room: "d-technocore-radar", count: 0, first_seq: null, last_seq: 1, messages: [], posted: { seq: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const send = createTechnocoreVerifierSender(verifierIdentity, 5000);
    const result = await send("d-technocore-radar", "hello from the verifier");
    assert.equal(result.seq, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.TECHNOCORE_IDENTITY_PATH;
    else process.env.TECHNOCORE_IDENTITY_PATH = previous;
  }

  assert.ok(capturedUrl, "expected a request to have been sent");
  // The URL is .../r/<room>/say-signed/<did>/<sig>/<nonce>/<text> -- assert
  // the DID segment is the verifier's, and specifically not the radar DID.
  const didSegment = capturedUrl!.split("/say-signed/")[1]?.split("/")[0];
  assert.equal(decodeURIComponent(didSegment ?? ""), verifierIdentity.did);
});
