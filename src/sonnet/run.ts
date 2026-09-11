/**
 * `sonnet:run` -- mostly a READ-ONLY monitoring loop, with ONE conditional
 * write path: auto-signing a roster (see maybeAutoSignRoster below), gated
 * on SONNET_AUTO_TEAM (operator opt-in, explicitly confirmed -- default
 * false) AND still subject to SONNET_DRY_RUN like every other write path in
 * this project. This is deliberately not yet the full autonomous daemon the
 * architecture doc describes (poll -> fold protocol events -> update state
 * -> determine action -> validate -> act or log -> sleep): the actual
 * WRITING of the poem needs room-poller.ts, poetry-planner.ts, submit.ts,
 * campaign.ts and voting.ts, none of which exist yet (see README "Sonnet
 * Challenge" Status).
 *
 * Auto-signing a roster is IRREVERSIBLE once the roster's first word is
 * accepted (sonnet-game.md: "The first accepted word atomically freezes the
 * fully consented roster") -- SONNET_AUTO_TEAM is an explicit, informed
 * operator choice to skip the per-action confirmation this project uses
 * everywhere else, not a default.
 */

import { TechnocoreClient } from "../technocore.js";
import type { SonnetAgentIdentity } from "./identity.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { scan as scanRooms, toDiscoverySnapshot, type ObservedRoster } from "./discovery.js";
import { checkRoomSetup } from "./team.js";
import { signRoster, RosterError } from "./roster.js";
import { transition, type SonnetState } from "./state.js";
import { saveState } from "./state.js";
import { sonnetLog, sonnetError } from "./logger.js";

export interface PollTickResult {
  /** game_ids (ours or joined) whose team room was observed set up THIS
   * tick for the first time. */
  newlySetUpRooms: string[];
  /** game_ids (from pendingJoinInterests) where a roster.v1 was observed
   * THIS tick that includes our own DID -- the actual "you're in" signal. */
  newlyAcceptedIntoTeams: string[];
  /** New roster.v1 proposals for OUR OWN game_id (someone wants to join us),
   * not yet logged in an earlier tick. */
  newRosterProposalsForOwnTeam: Array<{ did: string; members: string[]; requestId: string }>;
  /** Set only when SONNET_AUTO_TEAM signed a roster THIS tick. */
  autoSignedRoster?: { gameId: string; requestId: string };
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
  const newlyAcceptedIntoTeams: string[] = [];
  const newRosterProposalsForOwnTeam: Array<{ did: string; members: string[]; requestId: string }> = [];

  const ourTeam = nextState.team;
  if (ourTeam) {
    if (ourTeam.roomGeneration === undefined) {
      const setup = await checkRoomSetup(contest, config, ourTeam.gameId, client);
      if (setup.hasMessages) {
        sonnetLog("TEAM", `our requested room is now set up: game_id=${ourTeam.gameId} generation=${setup.generation}`);
        nextState = { ...nextState, team: { ...ourTeam, room: setup.room, roomGeneration: setup.generation } };
        if (nextState.phase === "TEAM_REQUESTED") nextState = transition(nextState, "ROOM_ASSIGNED");
        newlySetUpRooms.push(ourTeam.gameId);
      }
    }

    // Anyone proposing sonnet.roster.v1 for OUR game_id is the "someone
    // wants to join" signal -- announce each one exactly once.
    const alreadyNotified = new Set(ourTeam.notifiedRosterRequestIds ?? []);
    const proposalsForUs = scanResult.rosterProposals.filter((r) => r.gameId === ourTeam.gameId);
    const freshProposals = proposalsForUs.filter((r) => !alreadyNotified.has(r.requestId));
    for (const proposal of freshProposals) {
      sonnetLog(
        "TEAM",
        `roster proposal observed for our game_id=${ourTeam.gameId}: by=${proposal.did} members=[${proposal.members.join(", ")}]`,
      );
      newRosterProposalsForOwnTeam.push({ did: proposal.did, members: proposal.members, requestId: proposal.requestId });
    }
    if (freshProposals.length > 0) {
      const latestTeam = nextState.team ?? ourTeam;
      nextState = {
        ...nextState,
        team: { ...latestTeam, notifiedRosterRequestIds: [...alreadyNotified, ...freshProposals.map((p) => p.requestId)] },
      };
    }
  }

  if (nextState.pendingJoinInterests && nextState.pendingJoinInterests.length > 0) {
    const updated = await Promise.all(
      nextState.pendingJoinInterests.map(async (interest) => {
        let next = interest;
        if (!next.roomSetUpAtUtc) {
          const setup = await checkRoomSetup(contest, config, interest.gameId, client);
          if (setup.hasMessages) {
            sonnetLog("TEAM", `a room we're interested in is now set up: game_id=${interest.gameId} generation=${setup.generation} -- checking whether its roster includes us`);
            newlySetUpRooms.push(interest.gameId);
            next = { ...next, roomSetUpAtUtc: new Date().toISOString() };
          }
        }
        // Check for our own DID in any roster.v1 proposal for this game_id --
        // the actual acceptance signal, independent of when the room itself
        // was set up (a roster can be proposed before or after that).
        if (!next.acceptedAtUtc) {
          const acceptedProposal = scanResult.rosterProposals.find((r) => r.gameId === interest.gameId && r.members.includes(agent.did));
          if (acceptedProposal) {
            sonnetLog("TEAM", `ACCEPTED into roster for game_id=${interest.gameId}: members=[${acceptedProposal.members.join(", ")}]`);
            newlyAcceptedIntoTeams.push(interest.gameId);
            next = { ...next, acceptedAtUtc: new Date().toISOString() };
          }
        }
        return next;
      }),
    );
    nextState = { ...nextState, pendingJoinInterests: updated };
  }

  const autoSignedRoster = config.autoTeam
    ? await maybeAutoSignRoster(agent, contest, config, nextState, scanResult.rosterProposals, ourTeam, client)
    : undefined;
  if (autoSignedRoster) nextState = autoSignedRoster.state;

  return {
    state: nextState,
    tick: {
      newlySetUpRooms,
      newlyAcceptedIntoTeams,
      newRosterProposalsForOwnTeam,
      autoSignedRoster: autoSignedRoster?.signed,
      registeredWriterCount: scanResult.registrations.filter((r) => r.role === "writer").length,
      registeredVoterCount: scanResult.registrations.filter((r) => r.role === "voter").length,
      pendingTeamRequestCount: scanResult.teamRequests.length,
    },
  };
}

interface RosterSignCandidate {
  gameId: string;
  proposal: ObservedRoster;
}

/**
 * SONNET_AUTO_TEAM's one write path: among every currently-observed roster
 * proposal that (a) includes our own DID, (b) has a valid 4-8 member count,
 * and (c) is for a game_id we're actually pursuing (our own team-request, or
 * a join interest we sent), sign the FIRST ONE not yet attempted --
 * "Each contributor may have one current roster consent for an unfinished
 * poem" (sonnet-game.md), so this only ever signs once per contest
 * (`!nextState.roster` below) and never retries a request_id it already
 * attempted (successfully or not), so a standing conflict doesn't spam a
 * sign attempt every tick forever. Still fully subject to SONNET_DRY_RUN --
 * this only ever builds+locally-verifies+confirms when dry-run is off, same
 * as every other write path in this project.
 */
async function maybeAutoSignRoster(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  state: SonnetState,
  rosterProposals: readonly ObservedRoster[],
  ourTeam: SonnetState["team"],
  client: TechnocoreClient,
): Promise<{ state: SonnetState; signed?: { gameId: string; requestId: string } } | undefined> {
  if (state.roster) return undefined; // already signed one this contest -- never a second

  const pursuedGameIds = new Set<string>();
  if (ourTeam) pursuedGameIds.add(ourTeam.gameId);
  for (const interest of state.pendingJoinInterests ?? []) pursuedGameIds.add(interest.gameId);
  if (pursuedGameIds.size === 0) return undefined;

  const alreadyAttempted = new Set(state.autoSignAttemptedRequestIds ?? []);
  const candidates: RosterSignCandidate[] = rosterProposals
    .filter(
      (p) =>
        pursuedGameIds.has(p.gameId) &&
        p.members.includes(agent.did) &&
        p.members.length >= 4 &&
        p.members.length <= 8 &&
        !alreadyAttempted.has(p.requestId),
    )
    .map((proposal) => ({ gameId: proposal.gameId, proposal }))
    .sort((a, b) => a.proposal.seq - b.proposal.seq);

  const candidate = candidates[0];
  if (!candidate) return undefined;

  sonnetLog(
    "ROSTER",
    `SONNET_AUTO_TEAM: attempting to sign observed roster for game_id=${candidate.gameId} members=[${candidate.proposal.members.join(", ")}]`,
  );

  const attempted = [...alreadyAttempted, candidate.proposal.requestId];
  try {
    const result = await signRoster(
      agent.identity,
      contest,
      config,
      { gameId: candidate.gameId, poemRoom: candidate.proposal.poemRoom, roomGeneration: candidate.proposal.roomGeneration, members: candidate.proposal.members },
      rosterProposals,
      client,
    );
    if (!result.sent) {
      // SONNET_DRY_RUN is true (the only reason signRoster returns
      // sent:false without throwing) -- never mark this attempted, so it's
      // retried for real once dry-run is turned off.
      return undefined;
    }
    let nextState: SonnetState = {
      ...state,
      autoSignAttemptedRequestIds: attempted,
      roster: { members: candidate.proposal.members, requestId: result.preview.payload.request_id, signedAtUtc: new Date().toISOString(), gameId: candidate.gameId },
    };
    if (nextState.phase === "ROOM_ASSIGNED") nextState = transition(nextState, "ROSTER_PENDING");
    return { state: nextState, signed: { gameId: candidate.gameId, requestId: result.preview.payload.request_id } };
  } catch (err) {
    sonnetLog("CONFLICT", `SONNET_AUTO_TEAM: not signing game_id=${candidate.gameId} -- ${err instanceof RosterError ? err.message : (err as Error).message}`);
    return { state: { ...state, autoSignAttemptedRequestIds: attempted } };
  }
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
        `tick complete: writers=${tick.registeredWriterCount} voters=${tick.registeredVoterCount} pending_team_requests=${tick.pendingTeamRequestCount} ` +
          `newly_set_up=[${tick.newlySetUpRooms.join(", ")}] newly_accepted=[${tick.newlyAcceptedIntoTeams.join(", ")}] new_roster_proposals_for_us=${tick.newRosterProposalsForOwnTeam.length}` +
          (tick.autoSignedRoster ? ` AUTO_SIGNED_ROSTER=${tick.autoSignedRoster.gameId}` : ""),
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
