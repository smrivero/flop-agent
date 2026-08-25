#!/usr/bin/env node
/**
 * Generate a local Ed25519 `did:key` identity for flop-agent.
 *
 * DOES NOT connect to technocore.chat or anywhere else. Purely local key generation
 * plus a deterministic encoding step, written to disk.
 *
 * Construction verified byte-for-byte against the official implementation:
 *   https://github.com/flop-labs/technocore-chat
 *     - src/didkey.py    (server-side verification / decoding)
 *     - scripts/sign.py  (reference signer / encoding: multibase(), did_of())
 *
 *   did:key:z6Mk...  =  "did:key:" + "z" + base58btc( 0xed 0x01 || <32-byte raw Ed25519 public key> )
 *
 *   - 0xed 0x01 is the varint-encoded multicodec for "ed25519-pub". Every Ed25519
 *     did:key therefore starts "did:key:z6Mk" (fixed, checked below).
 *   - base58btc here is the plain Bitcoin alphabet, big-endian big-integer encoding,
 *     with NO leading-zero-byte special case -- matching scripts/sign.py's
 *     `multibase()` exactly (safe here because the leading byte, 0xed, is never
 *     zero, so the special case Base58 usually needs never applies to this shape).
 *   - The encoded multibase segment (the "z..." part) is always 48 characters:
 *     2 codec bytes + 32 key bytes = 34 bytes, which base58btc-encodes to 47
 *     characters, plus the leading "z". src/didkey.py enforces this exact length.
 *
 * What gets saved to .technocore/identity.json is the minimal representation our
 * signing implementation (src/identity.ts) actually needs to re-derive everything
 * else: the DID (public, derivable from the seed anyway) and the 32-byte Ed25519
 * seed as hex. Nothing else is required -- the raw public key, the multicodec bytes
 * and the DID string are all cheaply re-derivable from the seed at load time.
 *
 * SECURITY
 *  - This script prints the DID and the file location only. It never prints,
 *    logs, or returns the seed / private key.
 *  - It refuses to overwrite an existing identity file unless --force is passed,
 *    so re-running it by accident cannot silently destroy a key already in use.
 *  - It sets restrictive permissions on the identity file (and its directory)
 *    where the platform supports POSIX file modes.
 *
 * This script is meant to be run manually, by you, from your own terminal:
 *
 *   node scripts/generate-identity.mjs
 *
 * Optional:
 *   node scripts/generate-identity.mjs --path .technocore/identity.json --force
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// -- did:key construction, mirroring scripts/sign.py exactly -----------------

const DID_PREFIX = "did:key:";
const MULTICODEC_ED25519 = Uint8Array.of(0xed, 0x01); // varint "ed25519-pub"
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const EXPECTED_MULTIBASE_LENGTH = 48; // "z" + 47 base58btc chars, per src/didkey.py

/**
 * base58btc-encode raw bytes as a big-endian big integer, matching
 * scripts/sign.py's `multibase()` (no leading-zero-byte special case).
 */
function base58btcEncode(bytes) {
  let n = 0n;
  for (const byte of bytes) {
    n = (n << 8n) | BigInt(byte);
  }
  if (n === 0n) return "";
  let out = "";
  while (n > 0n) {
    const rem = n % 58n;
    n /= 58n;
    out = B58_ALPHABET[Number(rem)] + out;
  }
  return out;
}

/** did:key:z6Mk... from a raw 32-byte Ed25519 public key. */
function didFromPublicKey(publicKeyBytes) {
  if (publicKeyBytes.length !== 32) {
    throw new Error(`internal: expected a 32-byte Ed25519 public key, got ${publicKeyBytes.length}`);
  }
  const multicodecBytes = new Uint8Array(MULTICODEC_ED25519.length + publicKeyBytes.length);
  multicodecBytes.set(MULTICODEC_ED25519, 0);
  multicodecBytes.set(publicKeyBytes, MULTICODEC_ED25519.length);

  const multibase = "z" + base58btcEncode(multicodecBytes);
  if (multibase.length !== EXPECTED_MULTIBASE_LENGTH) {
    throw new Error(`internal: bad multibase length ${multibase.length}, expected ${EXPECTED_MULTIBASE_LENGTH}`);
  }
  return DID_PREFIX + multibase;
}

// -- key generation ------------------------------------------------------------

/**
 * A fresh Ed25519 keypair, as raw bytes.
 *
 * Uses JWK export rather than picking apart DER/SPKI encodings by hand: Node's
 * OKP/Ed25519 JWK export gives the raw 32-byte seed (`d`) and raw 32-byte public
 * key (`x`) directly as base64url, with no ASN.1 prefix-stripping to get wrong.
 */
function generateEd25519Raw() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  const publicKeyBytes = Buffer.from(pubJwk.x, "base64url");
  const seedBytes = Buffer.from(privJwk.d, "base64url");
  if (publicKeyBytes.length !== 32 || seedBytes.length !== 32) {
    throw new Error("internal: unexpected Ed25519 key length from crypto.generateKeyPairSync");
  }
  return { publicKeyBytes, seedBytes };
}

// -- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { path: ".technocore/identity.json", force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--path") args.path = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/generate-identity.mjs [--path .technocore/identity.json] [--force]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const { path: relativePath, force } = parseArgs(process.argv.slice(2));
  const identityPath = resolve(process.cwd(), relativePath);

  if (existsSync(identityPath) && !force) {
    process.stderr.write(
      `${identityPath} already exists. Refusing to overwrite an existing identity.\n` +
        "Pass --force if you really mean to replace it (this destroys the old key).\n",
    );
    process.exit(1);
  }

  const { publicKeyBytes, seedBytes } = generateEd25519Raw();
  const did = didFromPublicKey(publicKeyBytes);

  const identity = {
    did,
    seedHex: seedBytes.toString("hex"),
  };

  const dir = dirname(identityPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });

  // Restrict permissions where the platform supports POSIX modes (no-op / best
  // effort on platforms that don't, e.g. plain Windows filesystems).
  try {
    chmodSync(dir, 0o700);
    chmodSync(identityPath, 0o600);
  } catch {
    // Filesystem doesn't support POSIX permission bits -- nothing more to do.
  }

  // Only public information, ever.
  process.stdout.write(`DID: ${did}\n`);
  process.stdout.write(`Identity file: ${identityPath}\n`);
}

main();
