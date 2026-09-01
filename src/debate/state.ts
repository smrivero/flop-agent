/**
 * Lightweight local memory: an aid for the prompt ("don't repeat this argument"),
 * never the source of truth for turn order (history.ts + the room itself are).
 * Bounded on every write so a debate that runs for months doesn't grow this file
 * without limit.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimRecord, DebateState } from "./types.js";

const MAX_RECENT_ITEMS = 20;
/** Cap on the structured claim history -- independent of MAX_RECENT_ITEMS
 * since claim records are richer objects and checkpoints want a bit more
 * history to summarize than the plain-string prompt-memory lists need. */
const MAX_CLAIM_RECORDS = 40;

function stateFilePath(statePath: string, room: string): string {
  return join(statePath, `${room}.json`);
}

/** UTC calendar day as YYYY-MM-DD -- the boundary MAX_MESSAGES_PER_DAY resets on. */
export function currentUtcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function defaultState(room: string): DebateState {
  const today = currentUtcDay();
  return {
    room,
    lastProcessedSeq: 0,
    lastSpeakerDid: null,
    totalMessages: 0,
    recentTopics: [],
    recentClaims: [],
    recentSources: [],
    currentDay: today,
    messagesToday: 0,
    claimRecords: [],
    claimStats: { verified: 0, disputed: 0, corrected: 0 },
    claimCounter: 0,
    messagesSinceCheckpoint: 0,
    checkpointCount: 0,
    lastArchiveAt: null,
    lastIdentityRefreshA: null,
    lastIdentityRefreshB: null,
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

/**
 * Rolls `messagesToday` back to 0 if the UTC day has changed since the state
 * was last written -- called once per turn, before checking the daily limit.
 * A pure day-string comparison, not a scheduled job: correct even if the
 * process was asleep (or down) across midnight, since the next turn just
 * notices the day changed and resets right then.
 */
export function rolloverDayIfNeeded(state: DebateState, now: Date = new Date()): DebateState {
  const today = currentUtcDay(now);
  if (state.currentDay === today) return state;
  return { ...state, currentDay: today, messagesToday: 0 };
}

/** Patches only the maintenance timestamps (archive / identity refresh) --
 * archive.ts and identityMaintenance.ts run on their own schedule, entirely
 * independent of debate turns, so this deliberately does not touch
 * updatedAt-adjacent turn fields the way recordTurn does. */
export function touchMaintenance(
  state: DebateState,
  patch: Partial<Pick<DebateState, "lastArchiveAt" | "lastIdentityRefreshA" | "lastIdentityRefreshB">>,
): DebateState {
  return { ...state, ...patch, updatedAt: new Date().toISOString() };
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
  /** A published, successfully-posted turn increments messagesToday and the
   * checkpoint countdown; a dry preview or a skipped turn never calls
   * recordTurn at all, so there's no separate flag for that here. */
  newClaimRecords?: Omit<ClaimRecord, "id">[];
  /** True when this turn published a checkpoint instead of a normal reply --
   * resets the checkpoint countdown rather than continuing to decrement it. */
  isCheckpoint?: boolean;
  now?: Date;
}

function nextClaimId(counter: number): string {
  return `claim-${String(counter).padStart(4, "0")}`;
}

/** Assigns sequential ids to freshly-resolved claims and folds their terminal
 * statuses into the lifetime claimStats counters -- claimStats only ever grows,
 * even once the claim itself ages out of the bounded claimRecords list below. */
function applyClaims(state: DebateState, additions: Omit<ClaimRecord, "id">[]): Pick<DebateState, "claimRecords" | "claimStats" | "claimCounter"> {
  let counter = state.claimCounter;
  const stats = { ...state.claimStats };
  const newRecords: ClaimRecord[] = additions.map((c) => {
    counter += 1;
    if (c.status === "verified") stats.verified += 1;
    else if (c.status === "disputed") stats.disputed += 1;
    else if (c.status === "corrected") stats.corrected += 1;
    return { ...c, id: nextClaimId(counter) };
  });
  return {
    claimRecords: [...newRecords, ...state.claimRecords].slice(0, MAX_CLAIM_RECORDS),
    claimStats: stats,
    claimCounter: counter,
  };
}

export function recordTurn(state: DebateState, update: TurnMemoryUpdate): DebateState {
  const rolled = rolloverDayIfNeeded(state, update.now);
  const claimUpdate = applyClaims(rolled, update.newClaimRecords ?? []);
  return {
    ...rolled,
    lastProcessedSeq: update.seq,
    lastSpeakerDid: update.speakerDid,
    totalMessages: rolled.totalMessages + 1,
    messagesToday: rolled.messagesToday + 1,
    recentTopics: pushBounded(rolled.recentTopics, update.newTopics ?? []),
    recentClaims: pushBounded(rolled.recentClaims, update.newClaims ?? []),
    recentSources: pushBounded(rolled.recentSources, update.newSources ?? []),
    ...claimUpdate,
    messagesSinceCheckpoint: update.isCheckpoint ? 0 : rolled.messagesSinceCheckpoint + 1,
    checkpointCount: rolled.checkpointCount + (update.isCheckpoint ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
}
