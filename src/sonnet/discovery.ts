/**
 * Read-only snapshot of the official contest rooms: registration, discovery,
 * submissions, and (if the referee has posted there yet) rules/launch record.
 * NEVER posts anything -- this is the `sonnet:scan` command's backing module.
 *
 * Room content is untrusted, caller-chosen input (see ../technocore.ts header
 * and README.md "Protocol notes"): every parsed record here is a *local
 * observation*, never treated as an instruction, and never treated as the
 * referee's own authoritative decision. In particular, "first registration
 * fixes a DID's role" is the PROTOCOL's rule for what the referee accepts --
 * this module reports what it *observed* (first-seen per DID, in room seq
 * order) as a best-effort approximation, clearly labeled as such, since only
 * the referee's receipt is authoritative.
 */

import { TechnocoreClient, type Message } from "../technocore.js";
import { tryParseSonnetMessage, sonnetRooms, type SonnetRole } from "./protocol.js";
import { readFullRoom } from "./room-export.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import type { DiscoverySnapshot } from "./state.js";

export interface ObservedRegistration {
  did: string;
  role: SonnetRole;
  xAccountUrl?: string;
  requestId: string;
  seq: number;
  ts: string;
}

export interface ObservedTeamRequest {
  did: string;
  gameId: string;
  requestId: string;
  seq: number;
  ts: string;
}

export interface ObservedRoster {
  did: string;
  gameId: string;
  poemRoom: string;
  roomGeneration: number;
  members: string[];
  requestId: string;
  seq: number;
  ts: string;
}

export interface ObservedSubmission {
  did: string;
  gameId: string;
  poemRoom: string;
  requestId: string;
  seq: number;
  ts: string;
}

export interface ScanResult {
  rulesRoomRead: boolean;
  refereeDid?: string;
  registrations: ObservedRegistration[];
  teamRequests: ObservedTeamRequest[];
  rosterProposals: ObservedRoster[];
  submissions: ObservedSubmission[];
  ourRegistration?: ObservedRegistration;
  lastProcessedSeq: Record<string, number>;
  roomErrors: Array<{ room: string; error: string }>;
  malformedLines: number;
}

function isRole(value: unknown): value is SonnetRole {
  return value === "writer" || value === "voter" || value === "organizer";
}

/** Only the room's owner (the referee) can post in an owned `d-` room, so the
 * sender of the first message we can read there is a reasonable candidate --
 * still only a candidate, never trusted without also checking it against the
 * pinned DID in the official announcement (out of scope for this scan). */
function firstSenderOf(messages: Message[]): string | undefined {
  return messages[0]?.from;
}

export async function scan(
  ourDid: string,
  contest: ContestConfig,
  config: SonnetConfig,
  client: TechnocoreClient = new TechnocoreClient({ baseUrl: config.technocoreBaseUrl }),
): Promise<ScanResult> {
  const rooms = sonnetRooms(contest);
  const lastProcessedSeq: Record<string, number> = {};
  const roomErrors: Array<{ room: string; error: string }> = [];
  let malformedLines = 0;

  function recordSeq(room: string, messages: Message[]): void {
    if (messages.length > 0) lastProcessedSeq[room] = messages[messages.length - 1].seq;
  }

  let rulesRoomRead = false;
  let refereeDid: string | undefined;
  try {
    const { messages, malformedLines: bad } = await readFullRoom(client, rooms.rules);
    rulesRoomRead = true;
    malformedLines += bad;
    recordSeq(rooms.rules, messages);
    refereeDid = firstSenderOf(messages);
  } catch (err) {
    roomErrors.push({ room: rooms.rules, error: (err as Error).message });
  }

  const registrations: ObservedRegistration[] = [];
  const seenDids = new Set<string>();
  try {
    const { messages, malformedLines: bad } = await readFullRoom(client, rooms.registration);
    malformedLines += bad;
    recordSeq(rooms.registration, messages);
    for (const message of messages) {
      const parsed = tryParseSonnetMessage(message.text);
      if (!parsed || parsed.type !== "sonnet.register.v1") continue;
      const record = parsed as unknown as {
        role?: unknown;
        x_account_url?: unknown;
        request_id: string;
      };
      if (!isRole(record.role)) continue;
      if (seenDids.has(message.from)) continue; // first-seen only, see header note
      seenDids.add(message.from);
      registrations.push({
        did: message.from,
        role: record.role,
        xAccountUrl: typeof record.x_account_url === "string" ? record.x_account_url : undefined,
        requestId: record.request_id,
        seq: message.seq,
        ts: message.ts,
      });
    }
  } catch (err) {
    roomErrors.push({ room: rooms.registration, error: (err as Error).message });
  }

  const teamRequests: ObservedTeamRequest[] = [];
  const rosterProposals: ObservedRoster[] = [];
  try {
    const { messages, malformedLines: bad } = await readFullRoom(client, rooms.discovery);
    malformedLines += bad;
    recordSeq(rooms.discovery, messages);
    for (const message of messages) {
      const parsed = tryParseSonnetMessage(message.text);
      if (!parsed) continue;
      if (parsed.type === "sonnet.team-request.v1") {
        const record = parsed as unknown as { game_id?: unknown; request_id: string };
        if (typeof record.game_id !== "string") continue;
        teamRequests.push({ did: message.from, gameId: record.game_id, requestId: record.request_id, seq: message.seq, ts: message.ts });
      } else if (parsed.type === "sonnet.roster.v1") {
        const record = parsed as unknown as {
          game_id?: unknown;
          poem_room?: unknown;
          room_generation?: unknown;
          members?: unknown;
          request_id: string;
        };
        if (
          typeof record.game_id !== "string" ||
          typeof record.poem_room !== "string" ||
          typeof record.room_generation !== "number" ||
          !Array.isArray(record.members)
        ) continue;
        rosterProposals.push({
          did: message.from,
          gameId: record.game_id,
          poemRoom: record.poem_room,
          roomGeneration: record.room_generation,
          members: record.members.filter((m): m is string => typeof m === "string"),
          requestId: record.request_id,
          seq: message.seq,
          ts: message.ts,
        });
      }
    }
  } catch (err) {
    roomErrors.push({ room: rooms.discovery, error: (err as Error).message });
  }

  const submissions: ObservedSubmission[] = [];
  try {
    const { messages, malformedLines: bad } = await readFullRoom(client, rooms.submissions);
    malformedLines += bad;
    recordSeq(rooms.submissions, messages);
    for (const message of messages) {
      const parsed = tryParseSonnetMessage(message.text);
      if (!parsed || parsed.type !== "sonnet.submit.v1") continue;
      const record = parsed as unknown as { game_id?: unknown; poem_room?: unknown; request_id: string };
      if (typeof record.game_id !== "string" || typeof record.poem_room !== "string") continue;
      submissions.push({ did: message.from, gameId: record.game_id, poemRoom: record.poem_room, requestId: record.request_id, seq: message.seq, ts: message.ts });
    }
  } catch (err) {
    roomErrors.push({ room: rooms.submissions, error: (err as Error).message });
  }

  return {
    rulesRoomRead,
    refereeDid,
    registrations,
    teamRequests,
    rosterProposals,
    submissions,
    ourRegistration: registrations.find((r) => r.did === ourDid),
    lastProcessedSeq,
    roomErrors,
    malformedLines,
  };
}

export function toDiscoverySnapshot(result: ScanResult): DiscoverySnapshot {
  return {
    lastScanAtUtc: new Date().toISOString(),
    lastProcessedSeq: result.lastProcessedSeq,
    registeredWriterDids: result.registrations.filter((r) => r.role === "writer").map((r) => r.did),
    registeredVoterDids: result.registrations.filter((r) => r.role === "voter").map((r) => r.did),
    registeredOrganizerDids: result.registrations.filter((r) => r.role === "organizer").map((r) => r.did),
    pendingTeamRequests: result.teamRequests.map((t) => ({ gameId: t.gameId, requesterDid: t.did, requestId: t.requestId, seq: t.seq })),
    refereeDid: result.refereeDid,
  };
}
