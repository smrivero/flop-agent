/**
 * Mint confirmation policies (STRICT | PROTOCOL | PROBE). The assessment reads only data the
 * referee published or that we can re-read; the policy decides which evidence may promote a
 * key to MINT_CONFIRMED (keys.ts POLICY_ACCEPTS). MINT_EXPECTED is always informational.
 *
 * Evidence, strongest first:
 *   flow.mints       our DID listed in a flow post (explicit; rarely available: lists are cut at 4,096 chars)
 *   room-acceptance  a room registered by this DID appears in flow.rooms. The referee only lists rooms
 *                    registered by owners (25 Sep, sweeps 60-67: 13/13 registrations by not-yet-owners
 *                    unlisted, 3/3 by owners listed, one of them with the owner registered in the SAME
 *                    sweep), flow.rooms can be truncated in a burst (26 Sep, sweep 222), so only PRESENCE counts as evidence.
 *                    Inference from observed behaviour, not a documented guarantee.
 *   probe            a probe trade of ours listed in flow.settled. Not adversary-proof if the probe id was
 *                    ever published unsettled (probe.test.ts case D) -- such a probe is rejected here.
 *   protocol         our signed owner message, byte-exact, in a room registered before its stamp, stamped
 *                    no later than the lock, in a sweep the referee has published, outside every missed
 *                    range the referee reported, with no contrary evidence (a not_owner void of ours).
 */

import { lastClosedSweep, sweepForTime, type Contest } from "./contest.js";
import type { ConfirmationPolicyName, MintEvidence } from "./keys.js";
import { POLICY_ACCEPTS } from "./keys.js";
import { ownerMessageText } from "./protocol.js";
import { findRoomRegistration } from "./room.js";
import type { CcDb } from "./store.js";

export interface OwnerMessageRecord { did: string; room: string; seq: number; ts: string; text: string }

export interface MintAssessment {
  expected: MintEvidence | null;
  confirmed: MintEvidence | null;
  available: MintEvidence[];
  blockers: string[];
}

function flows(db: CcDb): { n: number; mints: string[]; rooms: string[]; missed: [string, number, number][] }[] {
  return (db.prepare("SELECT text FROM raw_posts WHERE room = 'd-close1-flow' ORDER BY seq").all() as { text: string }[])
    .map((r) => JSON.parse(r.text)).filter((f) => f && f.t === "flow");
}

export function strictEvidence(db: CcDb, did: string): MintEvidence | null {
  for (const f of flows(db)) if (f.mints?.includes(did)) return { source: "flow.mints", sweep: f.n, detail: "DID listed in flow.mints" };
  return null;
}

export function roomAcceptanceEvidence(db: CcDb, room: string, registrantConfirmedByUs: boolean): MintEvidence | null {
  if (!registrantConfirmedByUs) return null;
  const n = findRoomRegistration(db, room);
  return n === null ? null : { source: "room-acceptance", sweep: n, detail: `room ${room}, registered by this key, listed in flow.rooms` };
}

export function protocolEvidence(db: CcDb, contest: Contest, msg: OwnerMessageRecord, ourTradeIds: string[] = []): { evidence: MintEvidence | null; blockers: string[] } {
  const blockers: string[] = [];
  if (msg.text !== ownerMessageText(msg.did)) blockers.push("owner message text is not the exact registration shape");
  const stamp = sweepForTime(contest, Date.parse(msg.ts));
  if (stamp > contest.lockSweep) blockers.push(`stamped for sweep ${stamp}, after the lock`);
  const all = flows(db);
  if (msg.room !== "close1") {
    const listed = findRoomRegistration(db, msg.room);
    if (listed === null) blockers.push(`room ${msg.room} is not registered`);
    else if (listed >= stamp) blockers.push(`room ${msg.room} counts only after sweep ${listed}; message stamped for sweep ${stamp}`);
  }
  if (!all.some((f) => f.n >= stamp)) blockers.push(`the referee has not published sweep ${stamp} yet`);
  for (const f of all) {
    for (const [room, a, b] of f.missed ?? []) {
      if (room === msg.room && msg.seq >= a && msg.seq <= b) blockers.push(`seq ${msg.seq} of ${room} is inside a range the referee missed (sweep ${f.n})`);
    }
  }
  for (const id of ourTradeIds) {
    const v = db.prepare("SELECT n FROM void_ids WHERE id = ? AND reason = 'not_owner' AND n > ?").get(id, stamp) as { n: number } | undefined;
    if (v) blockers.push(`our trade ${id} was voided not_owner at sweep ${v.n}, after the registration`);
  }
  return { evidence: blockers.length ? null : { source: "protocol", sweep: stamp, detail: `owner message ${msg.room}#${msg.seq} stamped for sweep ${stamp}, published, not missed` }, blockers };
}

export function probeEvidence(db: CcDb, probeIds: string[], exposedUnsettled: Set<string>): { evidence: MintEvidence | null; blockers: string[] } {
  const blockers: string[] = [];
  for (const id of probeIds) {
    const s = db.prepare("SELECT n FROM settled_ids WHERE id = ?").get(id) as { n: number } | undefined;
    if (!s) continue;
    if (exposedUnsettled.has(id)) {
      blockers.push(`probe ${id} settled, but an earlier attempt was published unsettled: the settlement could be a copy`);
      continue;
    }
    return { evidence: { source: "probe", sweep: s.n, detail: `probe ${id} listed in flow.settled` }, blockers };
  }
  return { evidence: null, blockers };
}

/** Assess one key under a policy. Never promotes by time alone. */
export function assessMint(db: CcDb, contest: Contest, p: {
  did: string; policy: ConfirmationPolicyName; ownerMessage?: OwnerMessageRecord; registeredRoom?: string;
  probeIds?: string[]; probeExposedUnsettled?: Set<string>; ourTradeIds?: string[];
}): MintAssessment {
  const available: MintEvidence[] = [];
  const blockers: string[] = [];
  const strict = strictEvidence(db, p.did);
  if (strict) available.push(strict);
  if (p.registeredRoom) {
    const r = roomAcceptanceEvidence(db, p.registeredRoom, true);
    if (r) available.push(r);
  }
  let expected: MintEvidence | null = null;
  if (p.ownerMessage) {
    const pr = protocolEvidence(db, contest, p.ownerMessage, p.ourTradeIds);
    blockers.push(...pr.blockers);
    if (pr.evidence) { available.push(pr.evidence); expected = pr.evidence; }
  }
  if (p.probeIds?.length) {
    const pe = probeEvidence(db, p.probeIds, p.probeExposedUnsettled ?? new Set());
    blockers.push(...pe.blockers);
    if (pe.evidence) available.push(pe.evidence);
  }
  const accepted = POLICY_ACCEPTS[p.policy];
  const confirmed = available.find((e) => accepted.includes(e.source)) ?? null;
  return { expected: expected ?? (available[0] ?? null), confirmed, available, blockers };
}

export function currentSweep(contest: Contest, nowMs = Date.now()): number {
  return lastClosedSweep(contest, nowMs);
}
