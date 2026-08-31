/**
 * The room is the source of truth for turn order -- this module never consults
 * local state to decide who speaks next, only Technocore's own message history.
 * That's what makes a crash between "posted" and "wrote local state" safe: on
 * restart, this reads the room fresh, sees the post that already landed, and
 * hands the turn to the other agent -- nothing here remembers "I was about to
 * post as A" across a restart, because nothing needs to.
 *
 * Every message read from Technocore is untrusted, caller-chosen content
 * (manual.md TRUST) -- this module's own job is narrow (which of the two agent
 * DIDs said what, in what order); anything the *text* says is handled strictly
 * as debate content downstream, never as instructions to this code.
 */

import type { TechnocoreClient } from "../technocore.js";
import type { AgentId, DebateTurn } from "./types.js";

// The server clamps ?limit to this anyway (manual.md); reading the max in one
// call is cheap and avoids missing a turn if a non-agent message is interleaved
// (e.g. someone else in an unowned test room).
const HISTORY_READ_LIMIT = 200;

export interface RoomSnapshot {
  lastSeq: number;
  /** Oldest first, already filtered to only Agent A / Agent B signed messages. */
  turns: DebateTurn[];
}

export async function readDebateHistory(
  client: TechnocoreClient,
  room: string,
  agentADid: string,
  agentBDid: string,
): Promise<RoomSnapshot> {
  const view = await client.readRoom(room, { limit: HISTORY_READ_LIMIT });
  const turns: DebateTurn[] = [];
  for (const m of view.messages) {
    if (m.from === agentADid) turns.push({ seq: m.seq, agentId: "A", did: m.from, text: m.text, ts: m.ts });
    else if (m.from === agentBDid) turns.push({ seq: m.seq, agentId: "B", did: m.from, text: m.text, ts: m.ts });
    // Anything else (another nick/DID) is not part of this debate's turn order
    // or context -- ignored here, exactly as "only messages signed by Agent A
    // or Agent B should enter the debate context" requires.
  }
  return { lastSeq: view.last_seq, turns };
}

/** Empty room -> Agent A starts. Otherwise, whoever spoke last, the other speaks next. */
export function determineNextSpeaker(turns: DebateTurn[]): AgentId {
  if (turns.length === 0) return "A";
  return turns[turns.length - 1].agentId === "A" ? "B" : "A";
}

export function mostRecentTurns(turns: DebateTurn[], count: number): DebateTurn[] {
  return turns.slice(Math.max(0, turns.length - count));
}
