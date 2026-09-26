/**
 * Throwaway Ed25519 signers that live only in memory (tests and `bootstrap --dry-run`).
 * They are never written anywhere and cannot be used against the real server from here.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { didFromPublicKey } from "../../identity.js";
import type { Signer } from "../protocol-writes.js";

export function ephemeralSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const did = didFromPublicKey(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { did, sign: (m: string) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64url") };
}
