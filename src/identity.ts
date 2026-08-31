/**
 * Local Ed25519 `did:key` identity for the Technocore signed lane.
 *
 * Source of truth: https://github.com/flop-labs/technocore-chat
 *   - src/didkey.py    -- did:key parsing/verification (server side)
 *   - scripts/sign.py  -- reference signer (canonical strings, encodings)
 *   - src/manual.md, "SIGNING" / "IDENTITY" sections
 *
 * SECURITY
 *  - This module never logs, prints, or returns the seed / private key in any error
 *    message. Errors here name the identity *path*, never its contents.
 *  - `loadIdentity` (the primary, user-facing identity flow) never generates a
 *    keypair -- see scripts/generate-identity.mjs for that, run manually and
 *    separately, for the human operator's own identity.
 *  - `generateIdentitySeed` below is the one exception, and it is *not* wired into
 *    `loadIdentity` or the CLI: it exists only for callers that explicitly need to
 *    self-bootstrap a *different* identity unattended (e.g. an autonomous service's
 *    own agent DIDs, which must exist before the service can run without a human
 *    present to run the manual script). It never touches disk itself -- the caller
 *    decides if/where to persist the result, same discipline as everywhere else here.
 *  - It reads .technocore/identity.json once, synchronously, at load time, and uses
 *    the seed only to construct an in-memory Ed25519 KeyObject for signing --
 *    nothing derived from the seed is ever serialized back out except signatures.
 *
 * did:key construction (verified byte-for-byte against src/didkey.py and
 * scripts/sign.py -- see the round-trip check run while building this project):
 *
 *   did:key:z6Mk...  =  "did:key:" + "z" + base58btc( 0xed 0x01 || <32-byte raw Ed25519 public key> )
 *
 *   - 0xed 0x01 is the varint-encoded multicodec "ed25519-pub". Every Ed25519
 *     did:key therefore starts "did:key:z6Mk".
 *   - base58btc is the plain Bitcoin alphabet, big-endian big-integer encoding, with
 *     no leading-zero-byte special case (matches scripts/sign.py's `multibase()`;
 *     safe here because the leading byte, 0xed, is never zero).
 *   - The multibase segment (the "z..." part) is always 48 characters: 2 codec bytes
 *     + 32 key bytes = 34 bytes -> 47 base58btc characters, plus the leading "z".
 *     src/didkey.py enforces this exact length; so does this module.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export class IdentityError extends Error {}
export class DidError extends Error {}

// -- constants, mirrored from src/didkey.py -----------------------------------

const DID_PREFIX = "did:key:";
const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i]));
const MULTIBASE_CHARS = 48; // "z" + 47 base58btc chars
export const DID_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
// 64 raw bytes is 512 bits; 86 base64url chars carry 516, so the last char's low 4 bits
// are slack a correct encoder always zeroes -- only [AQgw] as the last char is canonical
// (server-enforced as of technocore-chat #178, confirmed against the live repo). Node's
// own base64url encoder always produces one of these, so this never affects our own
// signing -- only tightens what we accept when verifying someone else's.
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/; // 64 raw bytes, base64url, unpadded, canonical

// RFC 8410 fixed DER prefixes for Ed25519 (32-byte key material either way; the
// prefix length never varies, so concatenation is exact, not an approximation).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// -- did:key encode / decode ---------------------------------------------------

function base58btcEncode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  if (n === 0n) return "";
  let out = "";
  while (n > 0n) {
    const rem = n % 58n;
    n /= 58n;
    out = B58_ALPHABET[Number(rem)] + out;
  }
  return out;
}

function base58btcDecode(str: string): Buffer {
  let n = 0n;
  for (const ch of str) {
    const digit = B58_INDEX.get(ch);
    if (digit === undefined) {
      throw new DidError(`bad did:key: ${JSON.stringify(ch)} is not base58btc`);
    }
    n = n * 58n + BigInt(digit);
  }
  if (n === 0n) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

/** did:key:z6Mk... from a raw 32-byte Ed25519 public key. */
export function didFromPublicKey(publicKeyBytes: Uint8Array): string {
  if (publicKeyBytes.length !== 32) {
    throw new DidError(`expected a 32-byte Ed25519 public key, got ${publicKeyBytes.length}`);
  }
  const multicodecBytes = Buffer.concat([MULTICODEC_ED25519, Buffer.from(publicKeyBytes)]);
  const multibase = "z" + base58btcEncode(multicodecBytes);
  if (multibase.length !== MULTIBASE_CHARS) {
    throw new DidError(`internal: bad multibase length ${multibase.length}`);
  }
  return DID_PREFIX + multibase;
}

/**
 * Generate a fresh Ed25519 keypair and return it as `{ did, seedHex }` -- the same
 * shape `loadIdentity` expects on disk. Pure: no file I/O, nothing printed. See the
 * SECURITY note at the top of this file for who this is (and is not) for.
 *
 * Identical construction to scripts/generate-identity.mjs (JWK export for raw
 * key bytes, verified byte-for-byte against the official did:key decoder) --
 * kept as a second, independent implementation there deliberately, since that
 * script is meant to run with zero dependencies/imports for the manual flow.
 */
export function generateIdentitySeed(): { did: string; seedHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const seedBytes = Buffer.from((privateKey.export({ format: "jwk" }) as { d: string }).d, "base64url");
  return { did: didFromPublicKey(publicKeyBytes), seedHex: seedBytes.toString("hex") };
}

/** The 32 raw Ed25519 public-key bytes of a did:key, or throw DidError. Mirrors
 * src/didkey.py `public_key()` exactly, including its validation order. */
export function publicKeyFromDid(did: string): Buffer {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX)) {
    throw new DidError(`bad did:key: expected ${DID_PREFIX}z6Mk...`);
  }
  const mb = did.slice(DID_PREFIX.length);
  if (mb.length !== MULTIBASE_CHARS || !mb.startsWith("z")) {
    throw new DidError(
      `bad did:key: expected ${MULTIBASE_CHARS} multibase characters starting 'z', got ${mb.length}`,
    );
  }
  const decoded = base58btcDecode(mb.slice(1));
  if (decoded.length !== 34 || !decoded.subarray(0, 2).equals(MULTICODEC_ED25519)) {
    throw new DidError("bad did:key: only ed25519-pub (z6Mk...) keys are accepted");
  }
  return decoded.subarray(2);
}

export function isDid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    publicKeyFromDid(value);
    return true;
  } catch {
    return false;
  }
}

/** `did:key:z6Mk…2doK` -- matches src/didkey.py `abbreviate()`. */
export function abbreviateDid(did: string): string {
  const mb = did.slice(DID_PREFIX.length);
  return `${mb.slice(0, 4)}…${mb.slice(-4)}`;
}

/**
 * The convention (not a server feature) for publishing a DID note:
 * /kv/did/<fingerprint>, where fingerprint = first 16 hex chars of
 * lowercase SHA-256(did:key string) -- note keys cannot hold the colons/uppercase
 * of the raw DID. See patterns.md #3.
 */
export function didNoteFingerprint(did: string): string {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

// -- Ed25519 sign / verify over raw key bytes -----------------------------------

function privateKeyObjectFromSeed(seedBytes: Buffer) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seedBytes]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function publicKeyObjectFromRaw(publicKeyBytes: Buffer) {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, publicKeyBytes]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Raw 32-byte Ed25519 public key derived from a private KeyObject. */
function derivePublicKeyBytes(privateKey: ReturnType<typeof createPrivateKey>): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new IdentityError("internal: could not derive public key from private key");
  return Buffer.from(jwk.x, "base64url");
}

/**
 * Verify unless `signature` is `did`'s Ed25519 signature over `message` (UTF-8).
 * Pure and stateless -- does not touch any identity file. Mirrors src/didkey.py
 * `verify()`, but returns a boolean instead of raising (callers decide how to react).
 */
export function verifyEd25519(did: string, signature: string, message: string): boolean {
  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = publicKeyFromDid(did);
  } catch {
    return false;
  }
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  let raw: Buffer;
  try {
    raw = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (raw.length !== 64) return false;
  try {
    const keyObject = publicKeyObjectFromRaw(publicKeyBytes);
    return ed25519Verify(null, Buffer.from(message, "utf8"), keyObject, raw);
  } catch {
    return false;
  }
}

// -- loading a local identity ---------------------------------------------------

export interface TechnocoreIdentity {
  /** did:key:z6Mk... -- the public identifier, safe to log/share/publish. */
  readonly did: string;
  /**
   * Sign an already-canonicalized message string and return the 86-char base64url
   * signature. Callers (technocore.ts) build the canonical string per lane -- this
   * only signs bytes it is given.
   */
  sign(canonicalMessage: string): string;
}

export interface LoadIdentityOptions {
  /** Defaults to $TECHNOCORE_IDENTITY_PATH or .technocore/identity.json. */
  path?: string;
}

const DEFAULT_IDENTITY_PATH = ".technocore/identity.json";

/**
 * Load a previously (manually) generated identity from disk. Never creates one.
 *
 * Throws IdentityError with a message that names only the file *path*, never any
 * key material, on: missing file, malformed JSON, a shape that doesn't match, or a
 * seed whose derived DID doesn't match the stored `did` (a corrupted or hand-edited
 * file, caught before it can sign anything).
 */
export function loadIdentity(options: LoadIdentityOptions = {}): TechnocoreIdentity {
  const path = resolve(process.cwd(), options.path ?? process.env.TECHNOCORE_IDENTITY_PATH ?? DEFAULT_IDENTITY_PATH);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new IdentityError(
      `no identity file at ${path}. Generate one with: node scripts/generate-identity.mjs`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IdentityError(`${path} is not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new IdentityError(`${path} must contain a JSON object`);
  }
  const { did, seedHex } = parsed as { did?: unknown; seedHex?: unknown };

  if (typeof did !== "string" || !DID_PATTERN.test(did)) {
    throw new IdentityError(`${path}: "did" is missing or not a valid did:key`);
  }
  if (typeof seedHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new IdentityError(`${path}: "seedHex" is missing or not 64 hex characters`);
  }

  const seedBytes = Buffer.from(seedHex, "hex");
  const privateKey = privateKeyObjectFromSeed(seedBytes);
  const publicKeyBytes = derivePublicKeyBytes(privateKey);
  const derivedDid = didFromPublicKey(publicKeyBytes);

  if (derivedDid !== did) {
    throw new IdentityError(
      `${path}: the stored "did" does not match the key material in this file (expected ${derivedDid})`,
    );
  }

  return {
    did,
    sign(canonicalMessage: string): string {
      const signature = ed25519Sign(null, Buffer.from(canonicalMessage, "utf8"), privateKey);
      return signature.toString("base64url");
    },
  };
}

/** Convenience: the local identity's DID, without exposing a signer. */
export function getDid(options: LoadIdentityOptions = {}): string {
  return loadIdentity(options).did;
}
