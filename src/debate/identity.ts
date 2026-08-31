/**
 * Persistent per-agent identities for the debate service.
 *
 * "If it exists, load it. If it does not exist, generate it. NEVER regenerate a
 * DID just because the application restarted" -- so the check is a plain
 * existsSync on the exact path, not "did loadIdentity throw". A corrupt file, a
 * DID that doesn't match its own seed, bad JSON -- none of those are "missing",
 * and none of them get silently replaced with a new identity; they fail loudly,
 * because auto-"fixing" a broken identity file by overwriting it is how you lose
 * a key that still has messages attributed to it in a public room.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateIdentitySeed, loadIdentity, type TechnocoreIdentity } from "../identity.js";
import type { AgentId, LoadedAgent } from "./types.js";

export interface LoadOrCreateResult {
  identity: TechnocoreIdentity;
  created: boolean;
}

export function loadOrCreateIdentity(path: string): LoadOrCreateResult {
  const resolved = resolve(path);

  if (existsSync(resolved)) {
    return { identity: loadIdentity({ path: resolved }), created: false };
  }

  const { did, seedHex } = generateIdentitySeed();
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify({ did, seedHex }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(dirname(resolved), 0o700);
    chmodSync(resolved, 0o600);
  } catch {
    // Filesystem doesn't support POSIX permission bits -- best effort only.
  }

  return { identity: loadIdentity({ path: resolved }), created: true };
}

export function buildLoadedAgent(
  id: AgentId,
  identity: TechnocoreIdentity,
  name: string,
  position: string,
  opponentName: string,
  opponentPosition: string,
  personality: string,
): LoadedAgent {
  return { id, name, position, opponentName, opponentPosition, personality, did: identity.did, sign: identity.sign };
}
