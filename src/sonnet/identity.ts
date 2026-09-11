/**
 * Loads "Agent A" for the sonnet challenge: exactly the identity the rest of
 * this project already signs with (TECHNOCORE_IDENTITY_PATH / the default
 * .technocore/identity.json, via ../identity.js's loadIdentity()). This module
 * never generates a keypair and never accepts a path override -- see
 * config.ts's header comment for why there is deliberately no
 * SONNET_IDENTITY_PATH knob.
 *
 * Safety: "Agent B" (VERIFIER_IDENTITY_PATH, default .technocore/identityB.json)
 * must never register as a sonnet writer/voter/organizer -- confirmed with the
 * operator. loadSonnetIdentity() cross-checks this the same way
 * verifier/identity.ts cross-checks Radar vs Verifier: if VERIFIER_IDENTITY_PATH
 * happens to resolve to the same DID we're about to use (a misconfiguration),
 * this refuses to return an identity at all.
 */

import { loadIdentity, type TechnocoreIdentity } from "../identity.js";

export class SonnetIdentityError extends Error {}

export interface SonnetAgentIdentity {
  identity: TechnocoreIdentity;
  did: string;
  /** Resolved path this identity was loaded from (public -- just a filename). */
  identityPath: string;
}

const DEFAULT_IDENTITY_PATH = ".technocore/identity.json";

export function loadSonnetIdentity(env: NodeJS.ProcessEnv = process.env): SonnetAgentIdentity {
  const identityPath = env.TECHNOCORE_IDENTITY_PATH?.trim() || DEFAULT_IDENTITY_PATH;
  const identity = loadIdentity({ path: identityPath });

  const verifierPath = env.VERIFIER_IDENTITY_PATH?.trim();
  if (verifierPath) {
    let verifierDid: string | undefined;
    try {
      verifierDid = loadIdentity({ path: verifierPath }).did;
    } catch {
      // Agent B's identity file may legitimately not exist in every checkout
      // (it's gitignored); absence is not a conflict, only a DID match is.
      verifierDid = undefined;
    }
    if (verifierDid && verifierDid === identity.did) {
      throw new SonnetIdentityError(
        `TECHNOCORE_IDENTITY_PATH (${identityPath}) and VERIFIER_IDENTITY_PATH (${verifierPath}) resolve to the ` +
          "same DID. Refusing to use it for the sonnet challenge -- Agent B must never register as a writer/voter.",
      );
    }
  }

  return { identity, did: identity.did, identityPath };
}
