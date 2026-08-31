/**
 * Lightweight local memory: an aid for the prompt ("don't repeat this argument"),
 * never the source of truth for turn order (history.ts + the room itself are).
 * Bounded on every write so a debate that runs for months doesn't grow this file
 * without limit.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DebateState } from "./types.js";

const MAX_RECENT_ITEMS = 20;

function stateFilePath(statePath: string, room: string): string {
  return join(statePath, `${room}.json`);
}

export function defaultState(room: string): DebateState {
  return {
    room,
    lastProcessedSeq: 0,
    lastSpeakerDid: null,
    totalMessages: 0,
    recentTopics: [],
    recentClaims: [],
    recentSources: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Falls back to a fresh default state on any read/parse failure -- a corrupt or
 * missing state file is a memory aid lost, not a crash; the room itself still
 * has the real transcript and still governs turn order. */
export function loadState(statePath: string, room: string): DebateState {
  try {
    const raw = readFileSync(stateFilePath(statePath, room), "utf8");
    const parsed = JSON.parse(raw) as Partial<DebateState>;
    return { ...defaultState(room), ...parsed, room };
  } catch {
    return defaultState(room);
  }
}

export function saveState(statePath: string, state: DebateState): void {
  mkdirSync(statePath, { recursive: true });
  writeFileSync(stateFilePath(statePath, state.room), JSON.stringify(state, null, 2) + "\n");
}

/** Move-to-front with dedupe, capped at MAX_RECENT_ITEMS -- most-recent-first. */
function pushBounded(list: string[], items: string[]): string[] {
  const merged = [...items, ...list].filter((item) => item.trim().length > 0);
  const deduped: string[] = [];
  for (const item of merged) {
    if (!deduped.includes(item)) deduped.push(item);
  }
  return deduped.slice(0, MAX_RECENT_ITEMS);
}

export interface TurnMemoryUpdate {
  seq: number;
  speakerDid: string;
  newTopics?: string[];
  newClaims?: string[];
  newSources?: string[];
}

export function recordTurn(state: DebateState, update: TurnMemoryUpdate): DebateState {
  return {
    ...state,
    lastProcessedSeq: update.seq,
    lastSpeakerDid: update.speakerDid,
    totalMessages: state.totalMessages + 1,
    recentTopics: pushBounded(state.recentTopics, update.newTopics ?? []),
    recentClaims: pushBounded(state.recentClaims, update.newClaims ?? []),
    recentSources: pushBounded(state.recentSources, update.newSources ?? []),
    updatedAt: new Date().toISOString(),
  };
}
