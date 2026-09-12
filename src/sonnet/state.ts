/**
 * Local, restart-safe state for the sonnet flow. This is a LOCAL bookkeeping
 * aid only -- exactly like src/debate/state.ts's own state.json, it is never
 * the source of truth for anything the referee decides (registration
 * acceptance, roster freeze, word acceptance, submission, votes). On
 * disagreement with a fresh room read, the room always wins; a corrupt or
 * missing state.json only costs a re-scan, never a wrong protocol action.
 *
 * The phase labels below are INTERNAL bookkeeping only, chosen by this
 * project -- they are not official protocol states from sonnet-game.md (the
 * protocol itself has no named "state machine", only room contents and
 * referee receipts).
 *
 * Only fields modules implemented so far actually populate are read/written
 * here. Fields for not-yet-implemented modules (team/roster/poem/submission/
 * campaign/votes) are typed now, as `undefined` until those modules exist, so
 * the on-disk shape does not need a breaking migration when they land.
 */

import { readJsonFile, writeJsonFileAtomic } from "./persistence.js";
import { sonnetLog } from "./logger.js";

export type SonnetPhase =
  | "UNREGISTERED"
  | "REGISTERED"
  | "DISCOVERING"
  | "TEAM_REQUESTED"
  | "ROOM_ASSIGNED"
  | "ROSTER_PENDING"
  | "ROSTER_LOCKED"
  | "WRITING"
  | "COMPLETE"
  | "SUBMITTED"
  | "CAMPAIGNING"
  | "FINISHED";

/** Allowed forward transitions. Anything not listed here is refused by
 * transition() -- "no permitir acciones inconsistentes" per the state
 * machine requirement. Loops (e.g. re-entering DISCOVERING after a released
 * roster to start a new poem) are intentionally allowed where the protocol
 * itself allows re-forming a team (sonnet-game.md "Teams and identity"). */
const ALLOWED_TRANSITIONS: Record<SonnetPhase, SonnetPhase[]> = {
  UNREGISTERED: ["REGISTERED"],
  REGISTERED: ["DISCOVERING"],
  DISCOVERING: ["TEAM_REQUESTED"],
  TEAM_REQUESTED: ["ROOM_ASSIGNED", "DISCOVERING"],
  ROOM_ASSIGNED: ["ROSTER_PENDING"],
  ROSTER_PENDING: ["ROSTER_LOCKED", "ROOM_ASSIGNED", "DISCOVERING"],
  ROSTER_LOCKED: ["WRITING"],
  WRITING: ["COMPLETE"],
  COMPLETE: ["SUBMITTED"],
  SUBMITTED: ["CAMPAIGNING", "DISCOVERING"],
  CAMPAIGNING: ["FINISHED", "DISCOVERING"],
  FINISHED: ["DISCOVERING"],
};

export interface EligibilityCacheEntry {
  status: "eligible" | "unknown";
  checkedAtUtc: string;
  evidenceRoom?: string;
  evidenceSeq?: number;
  evidenceTs?: string;
}

export interface RegistrationState {
  role: "writer" | "voter" | "organizer";
  requestId: string;
  xAccountUrl?: string;
  /** Set once an ACCEPTED referee receipt referencing our request_id is
   * observed (see discovery.ts's ObservedReceipt) -- never set just because
   * our own post landed; posting successfully only means the room accepted
   * the bytes, not that the referee validated the request. */
  confirmedAtUtc?: string;
  confirmedSeq?: number;
  /** Set once a REJECTED referee receipt referencing our request_id is
   * observed. A rejected registration blocks everything downstream (team
   * requests, roster, words) -- see run.ts's pollOnce, which logs this once
   * under [SONNET][ERROR] rather than silently proceeding as if registered. */
  rejectedAtUtc?: string;
  rejectedReason?: string;
}

export interface DiscoverySnapshot {
  lastScanAtUtc: string;
  lastProcessedSeq: Record<string, number>;
  registeredWriterDids: string[];
  registeredVoterDids: string[];
  registeredOrganizerDids: string[];
  pendingTeamRequests: Array<{ gameId: string; requesterDid: string; requestId: string; seq: number }>;
  refereeDid?: string;
}

export interface SonnetState {
  contestId: string;
  ourDid: string;
  phase: SonnetPhase;

  eligibilityWriter?: EligibilityCacheEntry;
  eligibilityVoter?: EligibilityCacheEntry;

  registration?: RegistrationState;
  discovery?: DiscoverySnapshot;

  /** Last time a recruitment/join message (recruit.ts) was sent -- rate-limit
   * bookkeeping only, not protocol state. Shared by recruit and join so both
   * count against the same "don't spam discovery" clock. */
  lastRecruitAtUtc?: string;

  /** Other writers' team-requests we've expressed interest in joining
   * (recruit.ts's joinTeamRequest) -- populated by `sonnet:join`, watched by
   * `sonnet:run` (run.ts) for the referee setting up the room, which is the
   * first observable sign our interest may have been acted on. */
  pendingJoinInterests?: Array<{
    gameId: string;
    requesterDid: string;
    sentAtUtc: string;
    roomSetUpAtUtc?: string;
    /** Set once a sonnet.roster.v1 for this game_id is observed that
     * includes OUR OWN DID -- the actual "you're in" signal, distinct from
     * (and more meaningful than) the room merely existing. */
    acceptedAtUtc?: string;
  }>;

  /** Kept for backward compatibility with existing state.json files / the
   * primary team-request `sonnet:team` sends first -- the FULL set of team
   * requests we're pursuing (there can be several at once, as a hedge
   * against the referee never processing a given one; see
   * additionalTeamRequests) is `[team, ...additionalTeamRequests].filter(Boolean)`. */
  team?: {
    gameId: string;
    requestId: string;
    requestedAtUtc: string;
    room?: string;
    roomGeneration?: number;
    /** request_ids of roster.v1 proposals for our own game_id already
     * logged, so run.ts's monitoring loop announces each one once instead
     * of repeating it every tick. */
    notifiedRosterRequestIds?: string[];
  };
  /** Extra team-requests beyond the first (`team` above) -- same shape,
   * plural, sent as a hedge since the referee does not process every
   * team-request (confirmed empirically: some sit unprocessed for 9+
   * hours). Whichever one the referee actually sets up and a roster locks
   * for is the one `sonnet:run` proceeds with; the rest are simply never
   * acted on further. */
  additionalTeamRequests?: Array<{
    gameId: string;
    requestId: string;
    requestedAtUtc: string;
    room?: string;
    roomGeneration?: number;
    notifiedRosterRequestIds?: string[];
  }>;
  /** Team-requests (ours) the referee explicitly REJECTED (see
   * discovery.ts's ObservedReceipt) -- moved here out of `team`/
   * `additionalTeamRequests` the tick the rejection is observed, so run.ts
   * stops polling a dead game_id forever and the operator can see why a
   * request never turned into a room. Purely a historical record; nothing
   * reads this back. */
  deadTeamRequests?: Array<{
    gameId: string;
    requestId: string;
    requestedAtUtc: string;
    rejectedAtUtc: string;
    reason?: string;
  }>;
  /** `frozenAtUtc` is set only once discovery.ts observes the FIRST accepted
   * word in the poem room -- per sonnet-game.md, the roster freezes
   * atomically on the first accepted word, not on our own signature. */
  roster?: { members: string[]; requestId: string; signedAtUtc: string; frozenAtUtc?: string; gameId?: string };
  /** request_ids of roster.v1 proposals run.ts's SONNET_AUTO_TEAM auto-sign
   * step has already attempted (successfully or not) -- never retried, so a
   * genuine conflict doesn't spam [SONNET][CONFLICT] every tick forever. */
  autoSignAttemptedRequestIds?: string[];
  /** Populated once room-poller.ts / poetry-planner.ts exist (not yet implemented). */
  poem?: {
    version: number;
    previousStateHash: string;
    lines: string[];
    currentLineSyllables: number;
    previousContributorDid?: string;
  };
  /** Populated once submit.ts exists (not yet implemented). */
  submissions?: Array<{ gameId: string; entryId?: string; requestId: string; submittedAtUtc: string }>;
  /** Populated once campaign.ts exists (not yet implemented). */
  invitations?: Array<{ targetDid: string; entryId: string; requestId: string; sentAtUtc: string }>;
  /** Populated once voting.ts exists (not yet implemented), only if/when the
   * protocol/API exposes tallies to a non-referee reader. */
  knownVotes?: Array<{ entryId: string; voterDid: string; seq: number }>;

  updatedAtUtc: string;
}

export function defaultState(contestId: string, ourDid: string): SonnetState {
  return {
    contestId,
    ourDid,
    phase: "UNREGISTERED",
    updatedAtUtc: new Date().toISOString(),
  };
}

/** Falls back to a fresh default state on any read/parse failure -- a
 * corrupt or missing state.json is lost bookkeeping, not a crash; the room
 * itself still holds the real, authoritative history. */
export function loadState(statePath: string, contestId: string, ourDid: string): SonnetState {
  try {
    const parsed = readJsonFile<SonnetState>(statePath);
    if (!parsed) return defaultState(contestId, ourDid);
    if (parsed.contestId !== contestId || parsed.ourDid !== ourDid) {
      sonnetLog(
        "STATE",
        `ignoring ${statePath}: it belongs to contest_id=${parsed.contestId} did=${parsed.ourDid}, not the current contest_id=${contestId} did=${ourDid}`,
      );
      return defaultState(contestId, ourDid);
    }
    return parsed;
  } catch (err) {
    sonnetLog("STATE", `failed to load ${statePath}, starting fresh: ${(err as Error).message}`);
    return defaultState(contestId, ourDid);
  }
}

export function saveState(statePath: string, state: SonnetState): void {
  writeJsonFileAtomic(statePath, { ...state, updatedAtUtc: new Date().toISOString() });
}

export class InvalidTransitionError extends Error {}

/** Moves `state` to `next`, refusing (throwing InvalidTransitionError) any
 * transition not in ALLOWED_TRANSITIONS. Every transition is logged under
 * [SONNET][STATE], matching the "cada transición debe quedar logueada"
 * requirement. Does not persist -- call saveState() separately once the
 * caller has also applied whatever data change motivated the transition. */
export function transition(state: SonnetState, next: SonnetPhase): SonnetState {
  const allowed = ALLOWED_TRANSITIONS[state.phase] ?? [];
  if (!allowed.includes(next)) {
    throw new InvalidTransitionError(`invalid transition ${state.phase} -> ${next} (allowed: ${allowed.join(", ") || "none"})`);
  }
  sonnetLog("STATE", `${state.phase} -> ${next}`);
  return { ...state, phase: next, updatedAtUtc: new Date().toISOString() };
}
