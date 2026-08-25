import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import {
  didFromPublicKey,
  publicKeyFromDid,
  isDid,
  abbreviateDid,
  verifyEd25519,
  DID_PATTERN,
  SIGNATURE_PATTERN,
  DidError,
} from "./identity.js";

/**
 * A synthetic Ed25519 keypair for tests -- never touches .technocore/identity.json,
 * generated fresh per call so nothing here overlaps with a real identity.
 */
function makeTestKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const did = didFromPublicKey(publicKeyBytes);
  const sign = (message: string) => ed25519Sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
  return { did, sign, publicKeyBytes };
}

test("DID validity: didFromPublicKey / publicKeyFromDid round-trip", () => {
  const { did, publicKeyBytes } = makeTestKeypair();
  assert.match(did, DID_PATTERN);
  assert.equal(did.length, 56); // "did:key:" (8) + 48-char multibase segment
  assert.ok(publicKeyFromDid(did).equals(publicKeyBytes));
});

test("DID validity: isDid accepts a well-formed did:key and rejects garbage", () => {
  const { did } = makeTestKeypair();
  assert.equal(isDid(did), true);
  assert.equal(isDid("not-a-did"), false);
  assert.equal(isDid("did:key:z6Mktooshort"), false);
  assert.equal(isDid(did.replace("z6Mk", "z6Xk")), false); // wrong multicodec head
  assert.equal(isDid(123 as unknown as string), false);
});

test("DID validity: publicKeyFromDid rejects a bad base58 character", () => {
  const { did } = makeTestKeypair();
  const corrupted = did.slice(0, -1) + "0"; // '0' is never valid base58btc
  assert.throws(() => publicKeyFromDid(corrupted), DidError);
});

test("DID validity: abbreviateDid keeps the head and tail of the multibase segment", () => {
  const { did } = makeTestKeypair();
  const abbrev = abbreviateDid(did);
  const mb = did.slice("did:key:".length);
  assert.equal(abbrev, `${mb.slice(0, 4)}…${mb.slice(-4)}`);
});

test("local Ed25519 signature verification: valid signature over the exact message verifies", () => {
  const { did, sign } = makeTestKeypair();
  const message = "lobby|1700000000000|hello world";
  const signature = sign(message);
  assert.match(signature, SIGNATURE_PATTERN);
  assert.equal(verifyEd25519(did, signature, message), true);
});

test("local Ed25519 signature verification: wrong message fails", () => {
  const { did, sign } = makeTestKeypair();
  const signature = sign("lobby|1700000000000|hello world");
  assert.equal(verifyEd25519(did, signature, "lobby|1700000000000|hello WORLD"), false);
});

test("local Ed25519 signature verification: signature from a different key fails", () => {
  const a = makeTestKeypair();
  const b = makeTestKeypair();
  const message = "lobby|1700000000000|hello world";
  const signature = a.sign(message);
  assert.equal(verifyEd25519(b.did, signature, message), false);
});

test("signature encoding: 86-char unpadded base64url, and malformed encodings are rejected", () => {
  const { did, sign } = makeTestKeypair();
  const message = "lobby|1|hi";
  const signature = sign(message);

  assert.equal(signature.length, 86);
  assert.doesNotMatch(signature, /=/); // unpadded
  assert.doesNotMatch(signature, /[+/]/); // base64url, not base64

  assert.equal(verifyEd25519(did, signature.slice(0, -1), message), false); // wrong length
  assert.equal(verifyEd25519(did, signature.replace(/./, "!"), message), false); // invalid charset
});
