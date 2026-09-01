/**
 * Loads Agent B's identity via the exact same `loadIdentity` the rest of this
 * project already uses (`../identity.js`) -- no new loading mechanism, no new
 * signing code. The one thing added here is the cross-check against Radar's
 * identity: if a misconfiguration ever points both VERIFIER_IDENTITY_PATH and
 * TECHNOCORE_IDENTITY_PATH at the same file (or two files holding the same
 * key), the Verifier would be "independently" checking its own work -- this
 * refuses to publish rather than let that happen silently.
 */

import { loadIdentity, type TechnocoreIdentity } from "../identity.js";
import type { VerifierConfig } from "./config.js";

export class SameDidError extends Error {}

export interface VerifierIdentities {
  radarDid: string;
  verifier: TechnocoreIdentity;
}

/**
 * Loads both identities and aborts (throws SameDidError) if they resolve to
 * the same DID. Only Agent B's signer is returned -- Radar's identity is read
 * only far enough to compare its public DID, nothing about it is ever used to
 * sign, and its seed is never touched by this module beyond what `loadIdentity`
 * itself needs internally.
 */
export function loadVerifierIdentities(config: VerifierConfig): VerifierIdentities {
  const radar = loadIdentity({ path: config.radarIdentityPath });
  const verifier = loadIdentity({ path: config.verifierIdentityPath });

  if (radar.did === verifier.did) {
    throw new SameDidError(
      "[verifier] ERROR: Radar and Verifier resolve to the same DID. " +
        `Both ${config.radarIdentityPath} and ${config.verifierIdentityPath} sign as ${radar.did}. ` +
        "Refusing to publish -- this would let Radar verify its own work.",
    );
  }

  return { radarDid: radar.did, verifier };
}
