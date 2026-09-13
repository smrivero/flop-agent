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
import { createTechnocoreClient } from "./http-debug.js";
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

/** `sonnet.application.v1` -- not part of sonnet-game.md's own spec, but a
 * real, working convention confirmed live: multiple teams' own recruiting
 * tools instruct applicants to sign exactly this shape for a game_id they
 * want to join. This is what lets `maybeAutoProposeOwnRoster` (run.ts) see
 * who has applied to a game_id WE started, without depending on free-text
 * parsing (which varies too wildly between agents to be reliable). */
export interface ObservedApplication {
  did: string;
  gameId: string;
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

/** A referee `sonnet.receipt.v1` (or one entry of a batched
 * `sonnet.receipts.v1`) addressed to OUR OWN DID -- the only authoritative
 * accept/reject signal for anything we've sent (registration, team-request,
 * roster, ...). Never inferred from "we see our own post landed" -- posting
 * successfully only means the room accepted the bytes, not that the referee
 * validated the request. */
export interface ObservedReceipt {
  requestId: string;
  status: string;
  reason?: string;
  seq: number;
  ts: string;
}

export interface ScanResult {
  rulesRoomRead: boolean;
  refereeDid?: string;
  registrations: ObservedRegistration[];
  teamRequests: ObservedTeamRequest[];
  rosterProposals: ObservedRoster[];
  applications: ObservedApplication[];
  submissions: ObservedSubmission[];
  ourRegistration?: ObservedRegistration;
  /** Every receipt found (in the registration or discovery room) addressed
   * to our own DID, keyed by nothing in particular here -- callers look up
   * by request_id. See ObservedReceipt. */
  ownReceipts: ObservedReceipt[];
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

/** Not run through tryParseSonnetMessage -- the batched `sonnet.receipts.v1`
 * form has no top-level request_id (it's per-entry inside `receipts`), which
 * tryParseSonnetMessage's envelope check would reject outright. Both the
 * single `sonnet.receipt.v1` and batched forms are undocumented in
 * sonnet-game.md (observed live in both the registration and discovery
 * rooms, never specified) -- read defensively, never assumed authoritative
 * about fields it doesn't have. */
function collectOwnReceipts(messages: Message[], ourDid: string): ObservedReceipt[] {
  const out: ObservedReceipt[] = [];
  for (const message of messages) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== "string") continue;
    const reason = typeof obj.reason === "string" && obj.reason ? obj.reason : undefined;

    if (obj.type === "sonnet.receipt.v1") {
      if (obj.sender_did === ourDid && typeof obj.request_id === "string" && typeof obj.status === "string") {
        out.push({ requestId: obj.request_id, status: obj.status, reason, seq: message.seq, ts: message.ts });
      }
    } else if (obj.type === "sonnet.receipts.v1" && Array.isArray(obj.receipts) && typeof obj.status === "string") {
      for (const entry of obj.receipts) {
        if (
          entry &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).sender_did === ourDid &&
          typeof (entry as Record<string, unknown>).request_id === "string"
        ) {
          out.push({ requestId: (entry as Record<string, unknown>).request_id as string, status: obj.status, reason, seq: message.seq, ts: message.ts });
        }
      }
    }
  }
  return out;
}

export async function scan(
  ourDid: string,
  contest: ContestConfig,
  config: SonnetConfig,
  client: TechnocoreClient = createTechnocoreClient(config),
): Promise<ScanResult> {
  const rooms = sonnetRooms(contest);
  const lastProcessedSeq: Record<string, number> = {};
  const roomErrors: Array<{ room: string; error: string }> = [];
  const ownReceipts: ObservedReceipt[] = [];
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
    ownReceipts.push(...collectOwnReceipts(messages, ourDid));
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
  const applications: ObservedApplication[] = [];
  try {
    const { messages, malformedLines: bad } = await readFullRoom(client, rooms.discovery);
    malformedLines += bad;
    recordSeq(rooms.discovery, messages);
    ownReceipts.push(...collectOwnReceipts(messages, ourDid));
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
      } else if (parsed.type === "sonnet.application.v1") {
        const record = parsed as unknown as { game_id?: unknown; request_id: string };
        if (typeof record.game_id !== "string") continue;
        applications.push({ did: message.from, gameId: record.game_id, requestId: record.request_id, seq: message.seq, ts: message.ts });
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
    applications,
    submissions,
    ourRegistration: registrations.find((r) => r.did === ourDid),
    ownReceipts,
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
