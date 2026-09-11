/**
 * `sonnet:run` -- a READ-ONLY monitoring loop. This is deliberately not yet
 * the full autonomous daemon the architecture doc describes (poll -> fold
 * protocol events -> update state -> determine action -> validate -> act or
 * log -> sleep): the "determine action" / "act" steps need room-poller.ts,
 * poetry-planner.ts, submit.ts, campaign.ts and voting.ts, none of which
 * exist yet (see README "Sonnet Challenge" Status). What DOES exist and is
 * useful today is watching for the one thing that currently blocks us:
 * whether the referee has set up a team room we're waiting on (either our
 * own `sonnet:team` request, or a `sonnet:join` interest sent to someone
 * else's team-request).
 *
 * Every SONNET_AUTO_* flag stays irrelevant here -- this tick NEVER posts
 * anything, at any settings. It's `sonnet:scan` plus a persistent loop
 * around it, not a new write path.
 */

import { TechnocoreClient } from "../technocore.js";
import type { SonnetAgentIdentity } from "./identity.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { scan as scanRooms, toDiscoverySnapshot } from "./discovery.js";
import { checkRoomSetup } from "./team.js";
import { transition, type SonnetState } from "./state.js";
import { saveState } from "./state.js";
import { sonnetLog, sonnetError } from "./logger.js";

export interface PollTickResult {
  /** game_ids (ours or joined) whose team room was observed set up THIS
   * tick for the first time. */
  newlySetUpRooms: string[];
  registeredWriterCount: number;
  registeredVoterCount: number;
  pendingTeamRequestCount: number;
}

/**
 * One read-only pass: scan the official rooms, then check room setup for
 * every game_id we're waiting on (our own team-request and/or any pending
 * join interests). Returns the updated state (NOT yet persisted -- the
 * caller saves it) and a summary of what's new since the last tick.
 */
export async function pollOnce(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  state: SonnetState,
  client: TechnocoreClient = new TechnocoreClient({ baseUrl: config.technocoreBaseUrl }),
): Promise<{ state: SonnetState; tick: PollTickResult }> {
  const scanResult = await scanRooms(agent.did, contest, config, client);
  let nextState: SonnetState = { ...state, discovery: toDiscoverySnapshot(scanResult) };

  // Reconcile OUR OWN registration from what the room actually shows --
  // registration.ts/cli.ts only ever record `state.registration` on the
  // machine that ran `sonnet:register` itself; a fresh environment (a
  // different host, a wiped data/ dir) needs to learn about an
  // already-accepted registration from the room, not just from local
  // bookkeeping, the same way a stale/missing state.json self-heals
  // everywhere else in this module.
  if (!nextState.registration && scanResult.ourRegistration) {
    const observed = scanResult.ourRegistration;
    sonnetLog("STATE", `observed our own existing registration in the room: role=${observed.role} seq=${observed.seq} -- reconciling local state`);
    nextState = {
      ...nextState,
      registration: { role: observed.role, requestId: observed.requestId, xAccountUrl: observed.xAccountUrl, confirmedSeq: observed.seq },
    };
  }
  if (nextState.registration && nextState.phase === "UNREGISTERED") nextState = transition(nextState, "REGISTERED");
  if (nextState.phase === "REGISTERED") nextState = transition(nextState, "DISCOVERING");

  // Same self-healing for our own team-request: adopt the most recent one
  // WE signed, as observed in the room, if local state doesn't already know
  // about it (another environment sent it, or state.json was wiped).
  if (!nextState.team) {
    const ours = scanResult.teamRequests.filter((t) => t.did === agent.did).sort((a, b) => b.seq - a.seq)[0];
    if (ours) {
      sonnetLog("STATE", `observed our own existing team-request in the room: game_id=${ours.gameId} seq=${ours.seq} -- reconciling local state`);
      nextState = { ...nextState, team: { gameId: ours.gameId, requestId: ours.requestId, requestedAtUtc: ours.ts } };
      if (nextState.phase === "DISCOVERING") nextState = transition(nextState, "TEAM_REQUESTED");
    }
  }

  const newlySetUpRooms: string[] = [];

  const ourTeam = nextState.team;
  if (ourTeam && ourTeam.roomGeneration === undefined) {
    const setup = await checkRoomSetup(contest, config, ourTeam.gameId, client);
    if (setup.hasMessages) {
      sonnetLog("TEAM", `our requested room is now set up: game_id=${ourTeam.gameId} generation=${setup.generation}`);
      nextState = { ...nextState, team: { ...ourTeam, room: setup.room, roomGeneration: setup.generation } };
      if (nextState.phase === "TEAM_REQUESTED") nextState = transition(nextState, "ROOM_ASSIGNED");
      newlySetUpRooms.push(ourTeam.gameId);
    }
  }

  if (nextState.pendingJoinInterests && nextState.pendingJoinInterests.length > 0) {
    const updated = await Promise.all(
      nextState.pendingJoinInterests.map(async (interest) => {
        if (interest.roomSetUpAtUtc) return interest;
        const setup = await checkRoomSetup(contest, config, interest.gameId, client);
        if (!setup.hasMessages) return interest;
        sonnetLog("TEAM", `a room we're interested in is now set up: game_id=${interest.gameId} generation=${setup.generation} -- check whether its roster includes us`);
        newlySetUpRooms.push(interest.gameId);
        return { ...interest, roomSetUpAtUtc: new Date().toISOString() };
      }),
    );
    nextState = { ...nextState, pendingJoinInterests: updated };
  }

  return {
    state: nextState,
    tick: {
      newlySetUpRooms,
      registeredWriterCount: scanResult.registrations.filter((r) => r.role === "writer").length,
      registeredVoterCount: scanResult.registrations.filter((r) => r.role === "voter").length,
      pendingTeamRequestCount: scanResult.teamRequests.length,
    },
  };
}

export interface RunLoopOptions {
  /** Resolves once, right before the process would otherwise sleep -- tests
   * use this to run exactly one tick instead of an infinite loop. */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests -- defaults to a real TechnocoreClient, which
   * would otherwise make live network calls on every tick. */
  client?: TechnocoreClient;
  /** Injectable for tests -- defaults to the real atomic file writer, which
   * would otherwise touch disk on every tick. */
  saveState?: (path: string, state: SonnetState) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The actual `sonnet:run` loop: poll, log, persist, sleep (with jitter),
 * repeat -- until `SONNET_ENABLED` is false (checked once at startup, same
 * as protocol-watcher's own ENABLED gate: this process exits 0 immediately
 * rather than looping doing nothing) or `options.shouldStop()` says stop.
 */
export async function runLoop(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  statePath: string,
  loadState: (path: string, contestId: string, did: string) => SonnetState,
  options: RunLoopOptions = {},
): Promise<void> {
  if (!config.enabled) {
    sonnetLog("POLL", "SONNET_ENABLED is false -- exiting without polling. Set SONNET_ENABLED=true to run the monitoring loop.");
    return;
  }

  const sleep = options.sleep ?? defaultSleep;
  const save = options.saveState ?? saveState;
  sonnetLog("POLL", `starting monitoring loop (interval=${config.pollIntervalMs}ms, jitter up to ${config.actionJitterMs}ms)`);

  for (;;) {
    let state = loadState(statePath, contest.contest_id, agent.did);
    try {
      const { state: nextState, tick } = await pollOnce(agent, contest, config, state, options.client);
      state = nextState;
      save(statePath, state);
      sonnetLog(
        "POLL",
        `tick complete: writers=${tick.registeredWriterCount} voters=${tick.registeredVoterCount} pending_team_requests=${tick.pendingTeamRequestCount} newly_set_up=[${tick.newlySetUpRooms.join(", ")}]`,
      );
    } catch (err) {
      sonnetError("ERROR", `poll tick failed: ${(err as Error).message} -- state left unchanged, will retry next interval`);
    }

    if (options.shouldStop?.()) return;
    const jitter = Math.floor(Math.random() * config.actionJitterMs);
    await sleep(config.pollIntervalMs + jitter);
    if (options.shouldStop?.()) return;
  }
}
