/**
 * LIVE ONLY. Ed25519 signer backed by a per-key file in data/close-call/keys/.
 *
 * Nothing outside src/close-call/live/ may import this directory (guard.test.ts),
 * and this build refuses to start in live mode, so no runtime path reaches it.
 *
 * Key file: {"did": "did:key:z6Mk...", "seedHex": "<64 hex>"} -- the same schema as
 * the project's .technocore/identity.json. The directory must be mode 700 and the
 * file mode 600, owned by the service user; anything looser is refused. The seed
 * never leaves this module: no logging, no error message carries it.
 */

import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Signer } from "../protocol-writes.js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class KeyFileError extends Error {}

export function checkKeyFileMode(path: string): void {
  const f = statSync(path);
  const d = statSync(dirname(path));
  if ((f.mode & 0o077) !== 0) throw new KeyFileError(`${path}: permissions ${(f.mode & 0o777).toString(8)} (must be 600)`);
  if ((d.mode & 0o077) !== 0) throw new KeyFileError(`${dirname(path)}: permissions ${(d.mode & 0o777).toString(8)} (must be 700)`);
  if (typeof process.getuid === "function" && f.uid !== process.getuid()) throw new KeyFileError(`${path}: not owned by the service user`);
}

export function loadFileSigner(path: string, didFromPublicKey: (raw: Uint8Array) => string): Signer {
  checkKeyFileMode(path);
  let parsed: { did?: unknown; seedHex?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new KeyFileError(`${path}: not a valid key file`);
  }
  if (typeof parsed.seedHex !== "string" || !/^[0-9a-f]{64}$/.test(parsed.seedHex) || typeof parsed.did !== "string") {
    throw new KeyFileError(`${path}: expected {did, seedHex}`);
  }
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(parsed.seedHex, "hex")]), format: "der", type: "pkcs8" });
  const raw = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  const did = didFromPublicKey(raw);
  if (did !== parsed.did) throw new KeyFileError(`${path}: seed does not match the stored did`);
  return { did, sign: (message: string) => sign(null, Buffer.from(message, "utf8"), key).toString("base64url") };
}
