/**
 * Checkpoints are locally formatted from state, never model-generated -- the
 * numbers are exactly what's in claimStats/claimRecords, so there's nothing to
 * hallucinate and no OpenAI call to spend. They replace a normal turn
 * entirely, whichever agent's turn it naturally is, still signed and
 * published by that agent like any other message.
 */

import type { ClaimRecord, ClaimStats, DebateState } from "./types.js";

/** True when the NEXT published message (this one) is due to be a checkpoint
 * instead of a normal reply. `messagesSinceCheckpoint` counts successfully
 * published messages since the last checkpoint (or since the start). */
export function isCheckpointDue(state: DebateState, everyMessages: number, enabled: boolean): boolean {
  if (!enabled || everyMessages <= 0) return false;
  return state.messagesSinceCheckpoint >= everyMessages;
}

function findMostRecentCorrection(records: ClaimRecord[]): ClaimRecord | undefined {
  return records.find((r) => r.status === "corrected");
}

function collectSources(records: ClaimRecord[], limit: number): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    for (const source of record.sources) {
      if (seen.size >= limit) return Array.from(seen);
      seen.add(source);
    }
  }
  return Array.from(seen);
}

/**
 * The checkpoint's public text -- format matches the spec's example closely:
 * counts, one recent correction if there is one, and a short unresolved
 * question drawn from the debate topic/position framing (kept generic since
 * there's no reliable local way to phrase "the" open question without an
 * OpenAI call, which checkpoints deliberately avoid).
 */
export function formatCheckpoint(state: DebateState, checkpointNumber: number, openQuestion: string): string {
  const stats: ClaimStats = state.claimStats;
  const checked = stats.verified + stats.disputed + stats.corrected;
  const correction = findMostRecentCorrection(state.claimRecords);
  const sources = collectSources(state.claimRecords, 4);

  const lines = [
    `DEBATE CHECKPOINT #${checkpointNumber}`,
    "",
    `Claims checked: ${checked}`,
    `Verified: ${stats.verified}`,
    `Disputed: ${stats.disputed}`,
    `Corrected: ${stats.corrected}`,
  ];

  if (correction) {
    lines.push("", "Recent correction:", correction.claim);
  }

  lines.push("", "Current unresolved question:", openQuestion);

  if (sources.length > 0) {
    lines.push("", "Sources:", ...sources);
  }

  return lines.join("\n");
}
