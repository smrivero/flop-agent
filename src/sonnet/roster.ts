/**
 * Roster consent (`sonnet.roster.v1`, discovery room). "Each proposed member
 * signs the same roster... A changed roster needs fresh consent from
 * everyone" (sonnet-game.md "Teams and identity") -- so signing here is
 * gated on there being NO conflicting roster.v1 already observed for the
 * same game_id (a different members list from a different signer). This
 * module never signs through a conflict; it reports one and waits, per the
 * operator's own instruction.
 */

import { TechnocoreClient, buildSignedMessageRequest, verifySignatureLocally } from "../technocore.js";
import { createTechnocoreClient } from "./http-debug.js";
import type { TechnocoreIdentity } from "../identity.js";
import { buildRosterPayload, freshRequestId, sonnetRooms, toCanonicalJson } from "./protocol.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import type { ObservedRoster } from "./discovery.js";
import { sonnetLog } from "./logger.js";

export class RosterError extends Error {}

export interface RosterConflict {
  gameId: string;
  /** Every distinct members-list variant observed for this game_id, other
   * than the one we intend to sign. */
  conflictingProposals: ObservedRoster[];
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((did, i) => did === b[i]);
}

/**
 * Compares our intended members list against every roster.v1 already
 * observed for this game_id (from discovery.ts's scan). A proposal with the
 * SAME exact members list (order included -- "the same roster") is not a
 * conflict, it's a co-signer; anything else is.
 */
export function detectRosterConflict(gameId: string, intendedMembers: readonly string[], observed: readonly ObservedRoster[]): RosterConflict | undefined {
  const conflicting = observed.filter((r) => r.gameId === gameId && !sameMembers(r.members, intendedMembers));
  return conflicting.length > 0 ? { gameId, conflictingProposals: conflicting } : undefined;
}

export interface RosterSignerStatus {
  gameId: string;
  intendedMembers: string[];
  confirmedSigners: string[];
  pendingSigners: string[];
}

/** Among our intended roster's members, who has already signed the exact
 * same roster (per discovery.ts's observations) and who hasn't yet. */
export function summarizeRosterSigners(gameId: string, intendedMembers: readonly string[], observed: readonly ObservedRoster[]): RosterSignerStatus {
  const confirmed = new Set(
    observed.filter((r) => r.gameId === gameId && sameMembers(r.members, intendedMembers)).map((r) => r.did),
  );
  return {
    gameId,
    intendedMembers: [...intendedMembers],
    confirmedSigners: intendedMembers.filter((m) => confirmed.has(m)),
    pendingSigners: intendedMembers.filter((m) => !confirmed.has(m)),
  };
}

export interface RosterPreview {
  room: string;
  payload: ReturnType<typeof buildRosterPayload>;
  canonicalJson: string;
  did: string;
  signature: string;
  nonce: string;
  verifiedLocally: boolean;
}

export function buildRosterPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  options: { gameId: string; poemRoom: string; roomGeneration: number; members: string[]; requestId?: string },
): RosterPreview {
  const rooms = sonnetRooms(contest);
  const payload = buildRosterPayload({
    contestId: contest.contest_id,
    gameId: options.gameId,
    poemRoom: options.poemRoom,
    roomGeneration: options.roomGeneration,
    members: options.members,
    requestId: options.requestId ?? freshRequestId("roster"),
  });
  const canonicalJson = toCanonicalJson(payload);
  const built = buildSignedMessageRequest(rooms.discovery, canonicalJson, { identity, baseUrl: config.technocoreBaseUrl });
  return {
    room: rooms.discovery,
    payload,
    canonicalJson,
    did: built.did,
    signature: built.signature,
    nonce: built.nonce,
    verifiedLocally: verifySignatureLocally(built),
  };
}

export interface SignRosterResult {
  preview: RosterPreview;
  sent: boolean;
  postedSeq?: number;
}

export async function signRoster(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  options: { gameId: string; poemRoom: string; roomGeneration: number; members: string[]; requestId?: string },
  observedRosterProposals: readonly ObservedRoster[],
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<SignRosterResult> {
  const conflict = detectRosterConflict(options.gameId, options.members, observedRosterProposals);
  if (conflict) {
    sonnetLog("CONFLICT", `game_id=${options.gameId}: ${conflict.conflictingProposals.length} conflicting roster proposal(s) observed -- refusing to sign, waiting`);
    for (const c of conflict.conflictingProposals) {
      sonnetLog("CONFLICT", `  by=${c.did} members=[${c.members.join(", ")}] seq=${c.seq}`);
    }
    throw new RosterError(`game_id=${options.gameId} has a conflicting roster already observed -- not signing`);
  }

  const preview = buildRosterPreview(identity, contest, config, options);
  sonnetLog("ROSTER", `[PREPARE] room=${preview.room} payload=${preview.canonicalJson}`);

  if (config.dryRun) {
    sonnetLog("ROSTER", "[DRY-RUN] SONNET_DRY_RUN is true -- not publishing.");
    return { preview, sent: false };
  }
  if (!preview.verifiedLocally) throw new RosterError("local signature verification failed -- refusing to send");

  sonnetLog("ROSTER", `[SIGNED] did=${preview.did} nonce=${preview.nonce}`);
  const result = await client.sendSignedMessagePost(preview.room, preview.canonicalJson, { identity, baseUrl: config.technocoreBaseUrl });
  sonnetLog("ROSTER", `[SENT] seq=${result.posted.seq}`);
  return { preview, sent: true, postedSeq: result.posted.seq };
}
