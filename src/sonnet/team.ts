/**
 * Team formation: `sonnet.team-request.v1` (discovery room) and reading back
 * the referee's room setup. Mirrors registration.ts's dry-run/real/idempotent
 * pattern exactly -- see that module's header.
 *
 * The assigned poem room name is DETERMINISTIC (`sonnetRooms(contest).team(gameId)`,
 * per sonnet-game.md: "The referee allocates `d-sonnet-1-team-<game_id>`"), so
 * this never has to guess or wait for an announcement naming the room --
 * it just reads that room directly (every room is publicly readable) to see
 * whether the referee has set it up yet, and what its actual `room_generation`
 * is (from the export's `X-Room-Generation` header -- see room-export.ts).
 */

import { TechnocoreClient, buildSignedMessageRequest, verifySignatureLocally } from "../technocore.js";
import { createTechnocoreClient } from "./http-debug.js";
import type { TechnocoreIdentity } from "../identity.js";
import { buildTeamRequestPayload, freshRequestId, sonnetRooms, toCanonicalJson } from "./protocol.js";
import { readFullRoom } from "./room-export.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { sonnetLog } from "./logger.js";

export class TeamError extends Error {}

export interface TeamRequestPreview {
  room: string;
  payload: ReturnType<typeof buildTeamRequestPayload>;
  canonicalJson: string;
  did: string;
  signature: string;
  nonce: string;
  verifiedLocally: boolean;
}

export function buildTeamRequestPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  requestId?: string,
): TeamRequestPreview {
  const rooms = sonnetRooms(contest);
  const payload = buildTeamRequestPayload({ contestId: contest.contest_id, gameId, requestId: requestId ?? freshRequestId("team") });
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

export interface TeamRequestResult {
  preview: TeamRequestPreview;
  sent: boolean;
  postedSeq?: number;
}

/** Same safety contract as registration.ts's register(): refuses to send
 * while `config.dryRun` is true, and refuses re-sending a request for a
 * `gameId` this local state already has an entry for (idempotency is the
 * caller's job here, same as registration -- pass `alreadyRequested: true`
 * to make this a no-op preview instead). */
export async function requestTeam(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  options: { alreadyRequested?: boolean; requestId?: string } = {},
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<TeamRequestResult> {
  const preview = buildTeamRequestPreview(identity, contest, config, gameId, options.requestId);
  sonnetLog("TEAM", `[PREPARE] room=${preview.room} payload=${preview.canonicalJson}`);

  if (options.alreadyRequested) {
    sonnetLog("TEAM", `game_id=${gameId} already requested locally -- skipping, idempotent no-op`);
    return { preview, sent: false };
  }
  if (config.dryRun) {
    sonnetLog("TEAM", "[DRY-RUN] SONNET_DRY_RUN is true -- not publishing.");
    return { preview, sent: false };
  }
  if (!preview.verifiedLocally) throw new TeamError("local signature verification failed -- refusing to send");

  sonnetLog("TEAM", `[SIGNED] did=${preview.did} nonce=${preview.nonce}`);
  const result = await client.sendSignedMessagePost(preview.room, preview.canonicalJson, { identity, baseUrl: config.technocoreBaseUrl });
  sonnetLog("TEAM", `[SENT] seq=${result.posted.seq}`);
  return { preview, sent: true, postedSeq: result.posted.seq };
}

export interface RoomSetupStatus {
  room: string;
  /** undefined until the referee has claimed/written to the room at least
   * once -- an empty read is NOT proof the request failed (the referee may
   * simply not have processed it yet); it only means "not observed yet". */
  generation?: number;
  hasMessages: boolean;
  refereeCandidateDid?: string;
}

/** Reads the deterministic team room directly (no announcement needed) to
 * see whether the referee has set it up and what its actual generation is --
 * `sonnet.roster.v1` requires this exact `room_generation`. */
export async function checkRoomSetup(
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<RoomSetupStatus> {
  const room = sonnetRooms(contest).team(gameId);
  const { messages, generation } = await readFullRoom(client, room);
  return { room, generation, hasMessages: messages.length > 0, refereeCandidateDid: messages[0]?.from };
}
