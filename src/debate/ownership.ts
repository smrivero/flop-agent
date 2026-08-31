/**
 * Idempotent d-room ownership setup: Agent A claims the room, Agent B goes on
 * the allow-list. Follows the OWNED ROOMS section of the current manual
 * (manual.md) and the current `_note_write_gate` enforcement in app.py exactly
 * -- re-verified against the live repo while building this (2026-08-30):
 *
 *   claim:  GET /kv/room-owners/<room>/set-signed/<did>/<sig>/<claim_nonce>/<same did>?if_absent=1
 *           signature covers `room-owners|<room>|<claim_nonce>|<did>`
 *   allow:  GET /kv/room-allow/<room>/set-signed/<did>/<sig>/<greater_nonce>/<did1>%20<did2>
 *           signature covers `room-allow|<room>|<greater_nonce>|<value>`
 *
 * Both signed-note namespaces share /kv/room-nonce/<room> as their replay
 * counter -- read fresh before each write, never assumed.
 *
 * This module never attempts to overwrite a foreign owner. If the room is
 * already owned by a different DID, setup fails with a clear error and stops.
 */

import { buildSignedNoteRequest, TechnocoreError, type TechnocoreClient } from "../technocore.js";
import { DID_PATTERN } from "../identity.js";
import type { LoadedAgent } from "./types.js";

export class RoomOwnershipConflictError extends Error {}

export interface OwnershipSetupResult {
  room: string;
  claimed: boolean; // true only if this call performed the claim (false if already owned by Agent A)
  allowListUpdated: boolean; // true only if this call added Agent B (false if already listed)
}

function nonceGreaterThan(current: number): string {
  return String(Math.max(Date.now(), current + 1));
}

function parseDidList(value: string | null): string[] {
  if (!value) return [];
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => DID_PATTERN.test(token));
}

/**
 * Ensure Agent A owns `room` and Agent B is on its allow-list. Safe to call
 * every startup -- each step checks current state first and is a no-op if
 * already satisfied.
 *
 * Only meaningful for `d-` rooms; callers should skip this entirely for an
 * ordinary (non-ownable) room name, since claiming isn't possible or needed.
 */
export async function ensureRoomOwnership(
  client: TechnocoreClient,
  agentA: LoadedAgent,
  agentB: LoadedAgent,
  room: string,
  baseUrl: string,
): Promise<OwnershipSetupResult> {
  const currentOwner = await client.readNote("room-owners", room);
  let claimed = false;

  if (currentOwner === null) {
    // Claiming a room only works "from birth" -- fail clearly rather than let
    // the server's 403 be the first the caller hears about it.
    const view = await client.readRoom(room, { limit: 1 });
    if (view.last_seq > 0) {
      throw new RoomOwnershipConflictError(
        `/r/${room} already has messages and no owner note -- it can no longer be claimed ` +
          `(a room is ownable from birth or not at all). Pick a different, unused room name.`,
      );
    }

    const nonce = nonceGreaterThan(await client.readRoomNonce(room));
    const built = buildSignedNoteRequest("room-owners", room, agentA.did, { identity: agentA, nonce, baseUrl });
    try {
      await client.setSignedNote(built, { ifAbsent: true });
      claimed = true;
    } catch (err) {
      if (err instanceof TechnocoreError && err.status === 403) {
        // Lost a race with someone else claiming it between our read and our write.
        const raceOwner = await client.readNote("room-owners", room);
        if (raceOwner !== agentA.did) {
          throw new RoomOwnershipConflictError(
            `/r/${room} is owned by ${raceOwner ?? "another key"}, not Agent A (${agentA.did}). Refusing to overwrite ownership.`,
          );
        }
        // Someone else's process (e.g. our own retried call) already claimed it
        // for us -- fine, continue as "already owned by Agent A" below.
      } else {
        throw err;
      }
    }
  } else if (currentOwner !== agentA.did) {
    throw new RoomOwnershipConflictError(
      `/r/${room} is owned by ${currentOwner}, not Agent A (${agentA.did}). Refusing to overwrite ownership -- ` +
        `pick a different room, or manually hand it over from the current owner's key first.`,
    );
  }

  // Allow-list: additive, never wipes an existing entry (someone may have added
  // other keys to this room by hand).
  const currentAllowRaw = await client.readNote("room-allow", room);
  const currentAllow = parseDidList(currentAllowRaw);
  if (currentAllow.includes(agentB.did)) {
    return { room, claimed, allowListUpdated: false };
  }

  const newAllowList = Array.from(new Set([...currentAllow, agentB.did]));
  const allowNonce = nonceGreaterThan(await client.readRoomNonce(room));
  const builtAllow = buildSignedNoteRequest("room-allow", room, newAllowList.join(" "), {
    identity: agentA, // only the owner may write room-allow
    nonce: allowNonce,
    baseUrl,
  });
  await client.setSignedNote(builtAllow);

  return { room, claimed, allowListUpdated: true };
}
