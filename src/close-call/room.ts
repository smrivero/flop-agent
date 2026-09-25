/**
 * Our trading room's lifecycle (design: an owned `d-` room with an allow-list; see README.md).
 * Nothing here writes anything: it records states, and every step up requires evidence that
 * can only come from reading the server or the referee.
 *
 *   UNCREATED -> CLAIMED             room-owners note read back = our owner DID
 *   CLAIMED -> ALLOWLIST_PENDING     allow-list write sent (not yet verified)
 *   ALLOWLIST_PENDING -> REGISTER_PENDING
 *                                    room-allow note read back holds every DID we listed, AND our
 *                                    {"t":"room"} message has been posted
 *   REGISTER_PENDING -> REGISTER_CONFIRMED
 *                                    the room is listed in a referee flow post's `rooms`
 *   REGISTER_CONFIRMED -> READY      the owner key is MINT_CONFIRMED
 *   any -> ERROR
 */

import { createHash } from "node:crypto";
import { now, type CcDb } from "./store.js";

export type RoomStatus = "UNCREATED" | "CLAIMED" | "ALLOWLIST_PENDING" | "REGISTER_PENDING" | "REGISTER_CONFIRMED" | "READY" | "ERROR";
export const ROOM_STATUSES: RoomStatus[] = ["UNCREATED", "CLAIMED", "ALLOWLIST_PENDING", "REGISTER_PENDING", "REGISTER_CONFIRMED", "READY", "ERROR"];

const ROOM_EDGES: Record<RoomStatus, RoomStatus[]> = {
  UNCREATED: ["CLAIMED", "ERROR"],
  CLAIMED: ["ALLOWLIST_PENDING", "ERROR"],
  ALLOWLIST_PENDING: ["REGISTER_PENDING", "ERROR"],
  REGISTER_PENDING: ["REGISTER_CONFIRMED", "ERROR"],
  REGISTER_CONFIRMED: ["READY", "ERROR"],
  READY: ["ERROR"],
  ERROR: [],
};

export type RoomEvidence =
  | { kind: "owner-note"; owner: string }                                   // /kv/room-owners/<room> read back
  | { kind: "allow-sent"; dids: number }                                    // write sent, unverified
  | { kind: "allow-note+room-message"; value_sha256: string; dids: number; room_message_seq: number }
  | { kind: "flow.rooms"; sweep: number }
  | { kind: "owner-mint-confirmed"; owner: string; sweep: number }
  | { kind: "error"; reason: string };

const REQUIRED: Partial<Record<RoomStatus, RoomEvidence["kind"]>> = {
  CLAIMED: "owner-note",
  ALLOWLIST_PENDING: "allow-sent",
  REGISTER_PENDING: "allow-note+room-message",
  REGISTER_CONFIRMED: "flow.rooms",
  READY: "owner-mint-confirmed",
  ERROR: "error",
};

export class IllegalRoomTransition extends Error {}

export interface RoomRecord { name: string; status: RoomStatus; owner_did: string | null; evidence: string | null }

export function getRoom(db: CcDb, name: string): RoomRecord {
  const r = db.prepare("SELECT name, status, owner_did, evidence FROM rooms_state WHERE name = ?").get(name) as RoomRecord | undefined;
  return r ?? { name, status: "UNCREATED", owner_did: null, evidence: null };
}

export function transitionRoom(db: CcDb, name: string, to: RoomStatus, evidence: RoomEvidence, ownerDid?: string): RoomRecord {
  const cur = getRoom(db, name);
  if (!ROOM_EDGES[cur.status].includes(to)) throw new IllegalRoomTransition(`${name}: ${cur.status} -> ${to} is not allowed`);
  if (REQUIRED[to] && evidence.kind !== REQUIRED[to]) throw new IllegalRoomTransition(`${name}: ${to} needs evidence ${REQUIRED[to]}, got ${evidence.kind}`);
  if (to === "CLAIMED" && evidence.kind === "owner-note" && ownerDid && evidence.owner !== ownerDid) {
    throw new IllegalRoomTransition(`${name}: room-owners holds ${evidence.owner}, not our key`);
  }
  const history = cur.evidence ? (JSON.parse(cur.evidence) as unknown[]) : [];
  db.prepare(`INSERT INTO rooms_state (name, status, owner_did, evidence, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET status = excluded.status, owner_did = COALESCE(excluded.owner_did, rooms_state.owner_did),
    evidence = excluded.evidence, updated_at = excluded.updated_at`)
    .run(name, to, ownerDid ?? cur.owner_did, JSON.stringify([...history, { to, at: now(), ...evidence }]), now());
  return getRoom(db, name);
}

/** The allow-list value exactly as it would be written: DIDs joined by single spaces. */
export function allowListValue(dids: string[]): string {
  return dids.join(" ");
}

export function allowListMatches(readBack: string, dids: string[]): boolean {
  const got = new Set(readBack.trim().split(/\s+/));
  return dids.every((d) => got.has(d));
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The first referee flow post (stored locally) listing `room` among newly registered rooms. */
export function findRoomRegistration(db: CcDb, room: string): number | null {
  const rows = db.prepare("SELECT text FROM raw_posts WHERE room = 'd-close1-flow' AND text LIKE ? ORDER BY seq").all(`%"${room}"%`) as { text: string }[];
  for (const r of rows) {
    const f = JSON.parse(r.text) as { n: number; rooms?: string[] };
    if (f.rooms?.includes(room)) return f.n;
  }
  return null;
}

// ------------------------------------------------------------------ ownership refresh (planned, never executed here)

export interface OwnershipReader { readNote(ns: string, key: string): Promise<string | null> }

export interface RefreshPlan {
  action: "refresh" | "not-due" | "halt";
  reason: string;
  /** Write operations for journal.ts (owner note first, then allow-list), same values as today. */
  writes: { opKey: string; kind: "note-owners" | "note-allow"; signerId: string; room: string; value: string }[];
}

/**
 * Every `days` (default 5) re-sign room-owners and room-allow with EXACTLY their current
 * values, so neither note can idle out. It reads both notes first and refuses (halt,
 * room_ownership) if the owner is not ours or the allow-list is not exactly the
 * expected set: a refresh must never replace a different owner or list.
 */
export async function planOwnershipRefresh(reader: OwnershipReader, p: {
  room: string; ownerId: string; ownerDid: string; allowDids: string[]; lastRefreshMs: number | null; nowMs: number; days: number;
}): Promise<RefreshPlan> {
  if (p.lastRefreshMs !== null && p.nowMs - p.lastRefreshMs < p.days * 86_400_000) {
    return { action: "not-due", reason: `last refresh ${new Date(p.lastRefreshMs).toISOString()}`, writes: [] };
  }
  const owner = await reader.readNote("room-owners", p.room);
  if (owner === null) return { action: "halt", reason: `room-owners/${p.room} is missing: the claim is lost and cannot be re-made once the room has messages`, writes: [] };
  if (owner !== p.ownerDid) return { action: "halt", reason: `room-owners/${p.room} holds ${owner}, not our owner ${p.ownerDid}`, writes: [] };
  const allow = await reader.readNote("room-allow", p.room);
  const expected = allowListValue(p.allowDids);
  if (allow === null) return { action: "halt", reason: `room-allow/${p.room} is missing`, writes: [] };
  const got = new Set(allow.trim().split(/\s+/));
  if (got.size !== p.allowDids.length || !allowListMatches(allow, p.allowDids)) {
    return { action: "halt", reason: `room-allow/${p.room} differs from the expected ${p.allowDids.length} DIDs (has ${got.size}): not overwriting`, writes: [] };
  }
  const cycle = Math.floor(p.nowMs / (p.days * 86_400_000));
  return {
    action: "refresh",
    reason: "owner and allow-list verified; re-signing both with their current values",
    writes: [
      { opKey: `refresh:${p.room}:${cycle}:owners`, kind: "note-owners", signerId: p.ownerId, room: p.room, value: p.ownerDid },
      { opKey: `refresh:${p.room}:${cycle}:allow`, kind: "note-allow", signerId: p.ownerId, room: p.room, value: expected },
    ],
  };
}
