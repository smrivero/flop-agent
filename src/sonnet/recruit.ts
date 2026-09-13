/**
 * Discovery-room outreach: plain signed chat messages, not `sonnet.*` JSON
 * payloads. sonnet-game.md defines no dedicated message type for
 * recruitment or negotiation itself (only `sonnet.team-request.v1` and
 * `sonnet.roster.v1` are structured; see "Teams and identity": "Use
 * discovery to advertise capabilities, invite partners, accept or decline,
 * and negotiate") -- so this is ordinary signed text, deliberately NOT run
 * through protocol.ts's builders.
 *
 * Three message kinds, all rate-limited the same way (via `minIntervalMs` +
 * a caller-supplied last-sent timestamp; state.ts doesn't distinguish which
 * kind was last sent, so cli.ts should treat them as sharing one rate-limit
 * clock):
 *   - `recruit()`: a broadcast "writer available, looking for A team" message
 *     -- only right when we have no team-request of our own pending.
 *   - `recruitForOwnTeam()`: "I started game_id=X, join ME" -- once we have
 *     our own pending/assigned game_id, this is the correct message, not the
 *     generic one above (which would confusingly read as us looking to join
 *     someone else's team).
 *   - `joinTeamRequest()`: a targeted reply expressing interest in a
 *     SPECIFIC observed `sonnet.team-request.v1` (game_id + requester DID).
 *
 * Never sends unsolicited DMs or posts outside the official discovery room.
 */

import { TechnocoreClient, buildSignedMessageRequest, verifySignatureLocally } from "../technocore.js";
import { createTechnocoreClient } from "./http-debug.js";
import type { TechnocoreIdentity } from "../identity.js";
import { sonnetRooms } from "./protocol.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import type { DidWordCache } from "./did-words.js";
import { sonnetLog } from "./logger.js";

export class RecruitError extends Error {}

export interface RecruitMessageOptions {
  wordCache?: DidWordCache;
}

/** A short, factual recruitment message -- states what this agent can do,
 * not a claim about pre-start status (that's for the referee to verify, not
 * something to assert in a chat message). */
export function buildRecruitMessageText(contest: ContestConfig, options: RecruitMessageOptions = {}): string {
  const lines = [
    `Writer available for ${contest.contest_id}.`,
    "Automated CMUdict validation, syllable tracking and signed-state word proposals.",
  ];
  if (options.wordCache) {
    lines.push(`${options.wordCache.totalValidWords} dictionary words compatible with my DID.`);
  }
  lines.push("Looking for a team of 4-8 registered writers. Reply here or send a sonnet.team-request.v1.");
  return lines.join(" ");
}

/** For when WE already have a pending/assigned game_id and want to recruit
 * members INTO it -- distinct from buildRecruitMessageText, which reads as
 * "looking for a team" (someone else's) rather than "join mine". */
export function buildOwnTeamRecruitText(gameId: string, contest: ContestConfig, options: RecruitMessageOptions = {}): string {
  const lines = [
    `Started team-request game_id=${gameId} for ${contest.contest_id}.`,
    "Registered writer, automated CMUdict validation, syllable tracking and signed-state word proposals.",
  ];
  if (options.wordCache) {
    lines.push(`${options.wordCache.totalValidWords} dictionary words compatible with my DID.`);
  }
  lines.push(`Looking for 3-7 more registered writers to join (4-8 total). Reply here or send sonnet.roster.v1 with game_id=${gameId} once the room is set up.`);
  return lines.join(" ");
}

/** A short, targeted reply to a SPECIFIC observed team-request -- quotes the
 * game_id and requester so the thread is unambiguous even in a busy room. */
export function buildJoinInterestText(gameId: string, requesterDid: string, options: RecruitMessageOptions = {}): string {
  const lines = [
    `Re: team-request game_id=${gameId} by ${requesterDid}.`,
    "Registered writer, interested in joining this roster.",
  ];
  if (options.wordCache) {
    lines.push(`${options.wordCache.totalValidWords} dictionary words compatible with my DID.`);
  }
  lines.push("Let me know if you'd like me on the roster, or if it's already full.");
  return lines.join(" ");
}

export interface DiscoveryTextPreview {
  room: string;
  text: string;
  did: string;
  signature: string;
  nonce: string;
  verifiedLocally: boolean;
}

function buildDiscoveryTextPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  text: string,
): DiscoveryTextPreview {
  const room = sonnetRooms(contest).discovery;
  const built = buildSignedMessageRequest(room, text, { identity, baseUrl: config.technocoreBaseUrl });
  return { room, text, did: built.did, signature: built.signature, nonce: built.nonce, verifiedLocally: verifySignatureLocally(built) };
}

export function buildRecruitPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  options: RecruitMessageOptions = {},
): DiscoveryTextPreview {
  return buildDiscoveryTextPreview(identity, contest, config, buildRecruitMessageText(contest, options));
}

export function buildOwnTeamRecruitPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  options: RecruitMessageOptions = {},
): DiscoveryTextPreview {
  return buildDiscoveryTextPreview(identity, contest, config, buildOwnTeamRecruitText(gameId, contest, options));
}

export function buildJoinInterestPreview(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  requesterDid: string,
  options: RecruitMessageOptions = {},
): DiscoveryTextPreview {
  return buildDiscoveryTextPreview(identity, contest, config, buildJoinInterestText(gameId, requesterDid, options));
}

export interface DiscoverySendResult {
  preview: DiscoveryTextPreview;
  sent: boolean;
  postedSeq?: number;
  rateLimited: boolean;
}

async function sendDiscoveryText(
  category: "TEAM",
  preview: DiscoveryTextPreview,
  config: SonnetConfig,
  rateLimit: { lastSentAtUtc?: string; minIntervalMs: number },
  identity: TechnocoreIdentity,
  client: TechnocoreClient,
): Promise<DiscoverySendResult> {
  sonnetLog(category, `[PREPARE] room=${preview.room} text=${JSON.stringify(preview.text)}`);

  if (rateLimit.lastSentAtUtc) {
    const elapsedMs = Date.now() - Date.parse(rateLimit.lastSentAtUtc);
    if (Number.isFinite(elapsedMs) && elapsedMs < rateLimit.minIntervalMs) {
      sonnetLog(category, `rate limited -- last discovery message was ${Math.round(elapsedMs / 1000)}s ago, minimum interval is ${Math.round(rateLimit.minIntervalMs / 1000)}s`);
      return { preview, sent: false, rateLimited: true };
    }
  }
  if (config.dryRun) {
    sonnetLog(category, "[DRY-RUN] SONNET_DRY_RUN is true -- not publishing.");
    return { preview, sent: false, rateLimited: false };
  }
  if (!preview.verifiedLocally) throw new RecruitError("local signature verification failed -- refusing to send");

  sonnetLog(category, `[SIGNED] did=${preview.did} nonce=${preview.nonce}`);
  const result = await client.sendSignedMessagePost(preview.room, preview.text, { identity, baseUrl: config.technocoreBaseUrl });
  sonnetLog(category, `[SENT] seq=${result.posted.seq}`);

  // Independent read-back, not just trusting the POST response body -- same
  // discipline as registration.ts's real path (see SIGNED MESSAGES there).
  try {
    const readBack = await client.readRoom(preview.room, { since: Math.max(0, result.posted.seq - 1), limit: 5 });
    const echoed = readBack.messages.find((m) => m.seq === result.posted.seq);
    if (echoed && echoed.from === preview.did && echoed.text === preview.text) {
      sonnetLog(category, `[CONFIRMED] seq=${echoed.seq} from=${echoed.from}`);
    } else {
      sonnetLog(category, `[CONFIRMED] could not verify seq=${result.posted.seq} on read-back -- run sonnet:scan to check`);
    }
  } catch (err) {
    sonnetLog(category, `[CONFIRMED] read-back failed (${(err as Error).message}) -- run sonnet:scan to check`);
  }

  return { preview, sent: true, postedSeq: result.posted.seq, rateLimited: false };
}

export async function recruit(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  options: RecruitMessageOptions & { lastSentAtUtc?: string; minIntervalMs: number },
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<DiscoverySendResult> {
  const preview = buildRecruitPreview(identity, contest, config, options);
  return sendDiscoveryText("TEAM", preview, config, options, identity, client);
}

export async function recruitForOwnTeam(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  options: RecruitMessageOptions & { lastSentAtUtc?: string; minIntervalMs: number },
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<DiscoverySendResult> {
  const preview = buildOwnTeamRecruitPreview(identity, contest, config, gameId, options);
  return sendDiscoveryText("TEAM", preview, config, options, identity, client);
}

export async function joinTeamRequest(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  requesterDid: string,
  options: RecruitMessageOptions & { lastSentAtUtc?: string; minIntervalMs: number },
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<DiscoverySendResult> {
  const preview = buildJoinInterestPreview(identity, contest, config, gameId, requesterDid, options);
  return sendDiscoveryText("TEAM", preview, config, options, identity, client);
}

/** `sonnet.application.v1` with `text: "yes-<game_id>"` -- not part of
 * sonnet-game.md's own spec (only team-request.v1 and roster.v1 are
 * official), but confirmed live as a real, working convention: multiple
 * observed teams' own recruiting tools (e.g. floppysol.xyz/sonnet's "Join
 * team floppy" step) instruct applicants to sign exactly this shape and
 * state their own automation "accept[s] automatically" on it -- i.e. it's
 * what a team's own bot actually scans for, unlike the free-text
 * `joinTeamRequest` message above, which only a human moderator would
 * notice. Sent ALONGSIDE the plain-text one (belt and suspenders), never
 * instead of it, since sonnet-game.md itself defines no format here and
 * this is only ever a best-effort match to what other agents look for. */
export function buildApplicationPayload(contest: ContestConfig, gameId: string): { type: "sonnet.application.v1"; contest_id: string; game_id: string; request_id: string; text: string } {
  return {
    type: "sonnet.application.v1",
    contest_id: contest.contest_id,
    game_id: gameId,
    request_id: `apply-${gameId}-${Date.now()}`,
    text: `yes-${gameId}`,
  };
}

export async function applyToTeamRequest(
  identity: TechnocoreIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  gameId: string,
  options: { lastSentAtUtc?: string; minIntervalMs: number },
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<DiscoverySendResult> {
  const room = sonnetRooms(contest).discovery;
  const text = JSON.stringify(buildApplicationPayload(contest, gameId));
  const built = buildSignedMessageRequest(room, text, { identity, baseUrl: config.technocoreBaseUrl });
  const preview: DiscoveryTextPreview = { room, text, did: built.did, signature: built.signature, nonce: built.nonce, verifiedLocally: verifySignatureLocally(built) };
  return sendDiscoveryText("TEAM", preview, config, options, identity, client);
}
