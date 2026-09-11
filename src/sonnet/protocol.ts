/**
 * The official technocore-sonnet-challenge message protocol, ported exactly
 * from vendor/technocore-sonnet/sonnet-game.md ("Rooms and signed protocol").
 * This module owns only pure, network-free logic: room-name derivation,
 * message-shape types/builders, and the same word/DID grammar the official
 * `sonnet_validate.py` enforces (vendor/technocore-sonnet/sonnet_validate.py).
 *
 * Signing itself is NOT reimplemented here -- callers pass the JSON text this
 * module produces straight into ../technocore.js's buildSignedMessageRequest /
 * sendSignedMessagePost, exactly like every other feature in this project.
 *
 * DO NOT hand-edit message shapes without re-reading the vendored rule
 * document first; this repo's copy of the protocol must never drift from it.
 */

import { DID_PATTERN } from "../identity.js";
import type { ContestConfig } from "./config.js";

export const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,15}$/;

/** One English word with optional trailing punctuation -- verbatim port of
 * sonnet_validate.py's TOKEN regex. */
export const TOKEN_PATTERN = /^([A-Za-z]+(?:'[A-Za-z]+)*)[,.;:!?]?$/;
/** The word itself, no trailing punctuation -- verbatim port of WORD. */
export const WORD_PATTERN = /^[A-Za-z]+(?:'[A-Za-z]+)*$/;

// -- rooms -----------------------------------------------------------------

export interface SonnetRooms {
  rules: string;
  registration: string;
  discovery: string;
  campaign: string;
  votes: string;
  submissions: string;
  results: string;
  team(gameId: string): string;
}

/**
 * Derived from contest_id per the room table in sonnet-game.md ("Rooms and
 * signed protocol"). Never hardcode a literal room name elsewhere -- always go
 * through this, so a future contest_id in a re-vendored contest.json is
 * honored automatically.
 */
export function sonnetRooms(contest: ContestConfig): SonnetRooms {
  const id = contest.contest_id;
  return {
    rules: `d-${id}-rules`,
    registration: `mb-${id}-registration`,
    discovery: `mb-${id}-discovery`,
    campaign: `mb-${id}-campaign`,
    votes: `mb-${id}-votes`,
    submissions: `mb-${id}-submissions`,
    results: `d-${id}-results`,
    team(gameId: string): string {
      if (!GAME_ID_PATTERN.test(gameId)) {
        throw new RangeError(`invalid game_id: ${JSON.stringify(gameId)} (must match ${GAME_ID_PATTERN})`);
      }
      return `d-${id}-team-${gameId}`;
    },
  };
}

// -- message types (ported from the JSON examples in sonnet-game.md) -------

export type SonnetRole = "writer" | "voter" | "organizer";

export interface SonnetRegisterV1 {
  type: "sonnet.register.v1";
  contest_id: string;
  role: SonnetRole;
  x_account_url?: string;
  request_id: string;
}

export interface SonnetTeamRequestV1 {
  type: "sonnet.team-request.v1";
  contest_id: string;
  game_id: string;
  request_id: string;
}

export interface SonnetRosterV1 {
  type: "sonnet.roster.v1";
  contest_id: string;
  game_id: string;
  poem_room: string;
  room_generation: number;
  members: string[];
  request_id: string;
}

export interface SonnetWithdrawV1 {
  type: "sonnet.withdraw.v1";
  contest_id: string;
  game_id: string;
  request_id: string;
}

export interface SonnetWordV1 {
  type: "sonnet.word.v1";
  contest_id: string;
  game_id: string;
  room_generation: number;
  version: number;
  previous_state_hash: string;
  word: string;
  request_id: string;
}

export interface SonnetSubmitV1 {
  type: "sonnet.submit.v1";
  contest_id: string;
  game_id: string;
  poem_room: string;
  room_generation: number;
  final_version: number;
  poem_sha256: string;
  x_post_ids: string[];
  request_id: string;
}

export interface SonnetInviteV1 {
  type: "sonnet.invite.v1";
  contest_id: string;
  purpose: "vote";
  target_did: string;
  entry_id: string;
  request_id: string;
  text: string;
}

export interface SonnetReplyV1 {
  type: "sonnet.reply.v1";
  contest_id: string;
  in_reply_to: { sender_did: string; request_id: string };
  request_id: string;
  text: string;
}

export interface SonnetBallotV1 {
  type: "sonnet.ballot.v1";
  contest_id: string;
  voter_did: string;
  entry_id: string;
  request_id: string;
}

export interface SonnetClaimV1 {
  type: "sonnet.claim.v1";
  contest_id: string;
  request_id: string;
  destination: string;
}

export type SonnetMessage =
  | SonnetRegisterV1
  | SonnetTeamRequestV1
  | SonnetRosterV1
  | SonnetWithdrawV1
  | SonnetWordV1
  | SonnetSubmitV1
  | SonnetInviteV1
  | SonnetReplyV1
  | SonnetBallotV1
  | SonnetClaimV1;

/** Every message this protocol defines carries these three fields -- the
 * shared shape check discovery.ts's best-effort parser relies on. */
export interface SonnetMessageEnvelope {
  type: string;
  contest_id: string;
  request_id: string;
}

// -- canonical serialization -------------------------------------------------

/** Compact, single-line JSON -- exactly what the protocol requires as message
 * text (JSON.stringify with no indentation already produces no newlines, so
 * this is a no-op beyond documenting the requirement at the call site). */
export function toCanonicalJson(message: SonnetMessage): string {
  return JSON.stringify(message);
}

/** Best-effort parse of an arbitrary room message's text as a sonnet.* protocol
 * message. Returns undefined (never throws) on anything that isn't a
 * well-formed JSON object with the three envelope fields -- room content is
 * untrusted, caller-chosen input (see src/technocore.ts header / README
 * "Protocol notes"), so a malformed or unrelated message is just ignored. */
export function tryParseSonnetMessage(text: string): SonnetMessageEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.type === "string" &&
    obj.type.startsWith("sonnet.") &&
    typeof obj.contest_id === "string" &&
    typeof obj.request_id === "string"
  ) {
    return obj as unknown as SonnetMessageEnvelope;
  }
  return undefined;
}

// -- registration --------------------------------------------------------------

export class RegistrationPayloadError extends Error {}

/** Canonical `https://x.com/<handle>` shape -- sonnet-game.md requires this
 * exact form for a writer's declared account; handle rules per X's own
 * username policy (1-15 chars, letters/digits/underscore). */
const X_ACCOUNT_URL_PATTERN = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/;

export interface BuildRegisterOptions {
  role: SonnetRole;
  xAccountUrl?: string;
  requestId: string;
  contestId: string;
}

export function buildRegisterPayload(options: BuildRegisterOptions): SonnetRegisterV1 {
  const { role, xAccountUrl, requestId, contestId } = options;
  if (role !== "writer" && role !== "voter" && role !== "organizer") {
    throw new RegistrationPayloadError(`role must be "writer", "voter" or "organizer", got ${JSON.stringify(role)}`);
  }
  if (role === "writer") {
    if (!xAccountUrl || !X_ACCOUNT_URL_PATTERN.test(xAccountUrl)) {
      throw new RegistrationPayloadError(
        `writer registration requires a canonical x_account_url matching ${X_ACCOUNT_URL_PATTERN}, got ${JSON.stringify(xAccountUrl)}`,
      );
    }
  } else if (xAccountUrl) {
    throw new RegistrationPayloadError(`x_account_url must be omitted for role ${JSON.stringify(role)}`);
  }
  if (!requestId) throw new RegistrationPayloadError("request_id is required");

  const message: SonnetRegisterV1 = {
    type: "sonnet.register.v1",
    contest_id: contestId,
    role,
    request_id: requestId,
  };
  if (role === "writer" && xAccountUrl) message.x_account_url = xAccountUrl;
  return message;
}

/** A fresh, unique request_id: `<prefix>-<unix-ms>-<random>`. Not part of the
 * protocol's own format (it only requires uniqueness per (contest_id,
 * signer, request_id)); callers may also supply their own. */
export function freshRequestId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}

// -- team formation / roster / turns / submission -------------------------

export class ProtocolPayloadError extends Error {}

export function buildTeamRequestPayload(options: { contestId: string; gameId: string; requestId: string }): SonnetTeamRequestV1 {
  if (!GAME_ID_PATTERN.test(options.gameId)) {
    throw new ProtocolPayloadError(`game_id must match ${GAME_ID_PATTERN}, got ${JSON.stringify(options.gameId)}`);
  }
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return { type: "sonnet.team-request.v1", contest_id: options.contestId, game_id: options.gameId, request_id: options.requestId };
}

export interface BuildRosterOptions {
  contestId: string;
  gameId: string;
  poemRoom: string;
  roomGeneration: number;
  /** Exact registered writer DIDs, 4-8 members. Order is preserved as given
   * -- every signer must sign the byte-identical list, so ordering is a
   * team-coordination concern (see team.ts), not something this builder
   * normalizes on its own. */
  members: string[];
  requestId: string;
}

export function buildRosterPayload(options: BuildRosterOptions): SonnetRosterV1 {
  if (!GAME_ID_PATTERN.test(options.gameId)) {
    throw new ProtocolPayloadError(`game_id must match ${GAME_ID_PATTERN}, got ${JSON.stringify(options.gameId)}`);
  }
  if (options.members.length < 4 || options.members.length > 8) {
    throw new ProtocolPayloadError(`roster must have 4-8 members, got ${options.members.length}`);
  }
  for (const did of options.members) {
    if (!DID_PATTERN.test(did)) throw new ProtocolPayloadError(`not a valid registered writer DID: ${JSON.stringify(did)}`);
  }
  if (new Set(options.members).size !== options.members.length) {
    throw new ProtocolPayloadError("roster members must be distinct DIDs (no duplicates)");
  }
  if (!Number.isInteger(options.roomGeneration) || options.roomGeneration < 0) {
    throw new ProtocolPayloadError(`room_generation must be a non-negative integer, got ${JSON.stringify(options.roomGeneration)}`);
  }
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return {
    type: "sonnet.roster.v1",
    contest_id: options.contestId,
    game_id: options.gameId,
    poem_room: options.poemRoom,
    room_generation: options.roomGeneration,
    members: options.members,
    request_id: options.requestId,
  };
}

export function buildWithdrawPayload(options: { contestId: string; gameId: string; requestId: string }): SonnetWithdrawV1 {
  if (!GAME_ID_PATTERN.test(options.gameId)) {
    throw new ProtocolPayloadError(`game_id must match ${GAME_ID_PATTERN}, got ${JSON.stringify(options.gameId)}`);
  }
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return { type: "sonnet.withdraw.v1", contest_id: options.contestId, game_id: options.gameId, request_id: options.requestId };
}

export interface BuildWordOptions {
  contestId: string;
  gameId: string;
  roomGeneration: number;
  version: number;
  previousStateHash: string;
  word: string;
  requestId: string;
}

export function buildWordPayload(options: BuildWordOptions): SonnetWordV1 {
  if (!GAME_ID_PATTERN.test(options.gameId)) {
    throw new ProtocolPayloadError(`game_id must match ${GAME_ID_PATTERN}, got ${JSON.stringify(options.gameId)}`);
  }
  if (!TOKEN_PATTERN.test(options.word)) {
    throw new ProtocolPayloadError(`word must be one English word with optional trailing punctuation, got ${JSON.stringify(options.word)}`);
  }
  if (!Number.isInteger(options.version) || options.version < 0) {
    throw new ProtocolPayloadError(`version must be a non-negative integer, got ${JSON.stringify(options.version)}`);
  }
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return {
    type: "sonnet.word.v1",
    contest_id: options.contestId,
    game_id: options.gameId,
    room_generation: options.roomGeneration,
    version: options.version,
    previous_state_hash: options.previousStateHash,
    word: options.word,
    request_id: options.requestId,
  };
}

export interface BuildSubmitOptions {
  contestId: string;
  gameId: string;
  poemRoom: string;
  roomGeneration: number;
  finalVersion: number;
  poemSha256: string;
  xPostIds: string[];
  requestId: string;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function buildSubmitPayload(options: BuildSubmitOptions): SonnetSubmitV1 {
  if (!GAME_ID_PATTERN.test(options.gameId)) {
    throw new ProtocolPayloadError(`game_id must match ${GAME_ID_PATTERN}, got ${JSON.stringify(options.gameId)}`);
  }
  if (!SHA256_HEX_PATTERN.test(options.poemSha256)) {
    throw new ProtocolPayloadError(`poem_sha256 must be 64 lowercase hex characters, got ${JSON.stringify(options.poemSha256)}`);
  }
  if (options.xPostIds.length === 0) throw new ProtocolPayloadError("x_post_ids must include at least one post ID");
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return {
    type: "sonnet.submit.v1",
    contest_id: options.contestId,
    game_id: options.gameId,
    poem_room: options.poemRoom,
    room_generation: options.roomGeneration,
    final_version: options.finalVersion,
    poem_sha256: options.poemSha256,
    x_post_ids: options.xPostIds,
    request_id: options.requestId,
  };
}

// -- campaign / voting / claim (not yet wired to a CLI command) -----------

export function buildInvitePayload(options: { contestId: string; targetDid: string; entryId: string; requestId: string; text: string }): SonnetInviteV1 {
  if (!DID_PATTERN.test(options.targetDid)) throw new ProtocolPayloadError(`not a valid target DID: ${JSON.stringify(options.targetDid)}`);
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return {
    type: "sonnet.invite.v1",
    contest_id: options.contestId,
    purpose: "vote",
    target_did: options.targetDid,
    entry_id: options.entryId,
    request_id: options.requestId,
    text: options.text,
  };
}

export function buildBallotPayload(options: { contestId: string; voterDid: string; entryId: string; requestId: string }): SonnetBallotV1 {
  if (!DID_PATTERN.test(options.voterDid)) throw new ProtocolPayloadError(`not a valid voter DID: ${JSON.stringify(options.voterDid)}`);
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return { type: "sonnet.ballot.v1", contest_id: options.contestId, voter_did: options.voterDid, entry_id: options.entryId, request_id: options.requestId };
}

export function buildClaimPayload(options: { contestId: string; requestId: string; destination: string }): SonnetClaimV1 {
  if (!options.destination) throw new ProtocolPayloadError("destination is required");
  if (!options.requestId) throw new ProtocolPayloadError("request_id is required");
  return { type: "sonnet.claim.v1", contest_id: options.contestId, request_id: options.requestId, destination: options.destination };
}
