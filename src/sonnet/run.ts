/**
 * `sonnet:run` -- mostly a READ-ONLY monitoring loop, with TWO conditional
 * write paths, each its own explicit operator opt-in (both default false,
 * both still subject to SONNET_DRY_RUN like every other write path here):
 *
 *   - SONNET_AUTO_TEAM: auto-signs a roster (maybeAutoSignRoster below).
 *     IRREVERSIBLE once that roster's first word is accepted.
 *   - SONNET_AUTO_WRITE: once we have a signed roster, proposes the next
 *     word via propose.ts's full pipeline whenever it's actually our turn.
 *     propose.ts's own cheap gates (room set up, not the previous
 *     contributor, hash known, poem not complete) run BEFORE the LLM call,
 *     so a tick where it isn't our turn costs no OpenAI spend -- it just
 *     throws ProposeError immediately, logged and ignored.
 *
 * Still NOT automated even with both on: submit.ts, campaign.ts, voting.ts
 * don't exist yet, and submission specifically needs the final contributor
 * to publish from their own X account -- something this project has no
 * credentials or integration for and cannot do on its own, ever.
 */

import { TechnocoreClient } from "../technocore.js";
import type { SonnetAgentIdentity } from "./identity.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { scan as scanRooms, toDiscoverySnapshot, type ObservedRoster } from "./discovery.js";
import { checkRoomSetup } from "./team.js";
import { signRoster, RosterError } from "./roster.js";
import { proposeWord, ProposeError } from "./propose.js";
import type { Lexicon } from "./cmudict.js";
import type { RhymeIndex } from "./rhyme.js";
import { transition, type SonnetState } from "./state.js";
import { saveState } from "./state.js";
import { sonnetLog, sonnetError } from "./logger.js";

export interface WordResources {
  lexicon: Lexicon;
  rhymeIndex: RhymeIndex;
}

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
  /** Set only when SONNET_AUTO_WRITE successfully proposed (and had
   * accepted-by-the-server, per the independent read-back) a word THIS tick. */
  autoProposedWord?: { gameId: string; word: string; seq?: number };
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
  wordResources?: WordResources,
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

  // Same self-healing for our own team-request(s): adopt EVERY one WE signed,
  // as observed in the room, that local state doesn't already know about
  // (a different environment sent it, or state.json was wiped/fresh) -- not
  // just the first. This is what lets a hedge strategy (many `sonnet:team`
  // calls from one machine) be picked up automatically by another machine's
  // sonnet:run without any manual state.json copying.
  {
    const hadNoTeamBefore = !nextState.team;
    const knownGameIds = new Set([nextState.team?.gameId, ...(nextState.additionalTeamRequests ?? []).map((t) => t.gameId)].filter((g): g is string => g !== undefined));
    const untracked = scanResult.teamRequests.filter((t) => t.did === agent.did && !knownGameIds.has(t.gameId)).sort((a, b) => a.seq - b.seq);
    if (untracked.length > 0) {
      sonnetLog("STATE", `observed ${untracked.length} of our own team-request(s) in the room not yet tracked locally: [${untracked.map((t) => t.gameId).join(", ")}] -- reconciling`);
      let team = nextState.team;
      let additional = nextState.additionalTeamRequests ?? [];
      for (const t of untracked) {
        const entry = { gameId: t.gameId, requestId: t.requestId, requestedAtUtc: t.ts };
        if (!team) team = entry;
        else additional = [...additional, entry];
      }
      nextState = { ...nextState, team, additionalTeamRequests: additional };
      if (hadNoTeamBefore && nextState.phase === "DISCOVERING") nextState = transition(nextState, "TEAM_REQUESTED");
    }
  }

  const newlySetUpRooms: string[] = [];
  const newlyAcceptedIntoTeams: string[] = [];
  const newRosterProposalsForOwnTeam: Array<{ did: string; members: string[]; requestId: string }> = [];

  // Every team-request WE sent (the primary `team` slot plus any hedge
  // requests in `additionalTeamRequests`) gets the same treatment: check
  // whether its room is now set up, and whether anyone proposed a roster for
  // it. Processed together so a growing list of hedge requests doesn't need
  // its own separate loop.
  type TeamEntry = NonNullable<SonnetState["team"]>;
  const ownTeamEntries: TeamEntry[] = [nextState.team, ...(nextState.additionalTeamRequests ?? [])].filter(
    (t): t is TeamEntry => t !== undefined,
  );
  if (ownTeamEntries.length > 0) {
    const updatedEntries = await Promise.all(
      ownTeamEntries.map(async (entry) => {
        let next = entry;
        if (next.roomGeneration === undefined) {
          const setup = await checkRoomSetup(contest, config, next.gameId, client);
          if (setup.hasMessages) {
            sonnetLog("TEAM", `our requested room is now set up: game_id=${next.gameId} generation=${setup.generation}`);
            next = { ...next, room: setup.room, roomGeneration: setup.generation };
            newlySetUpRooms.push(next.gameId);
          }
        }

        // Anyone proposing sonnet.roster.v1 for this game_id is the "someone
        // wants to join" signal -- announce each one exactly once.
        const alreadyNotified = new Set(next.notifiedRosterRequestIds ?? []);
        const freshProposals = scanResult.rosterProposals.filter((r) => r.gameId === next.gameId && !alreadyNotified.has(r.requestId));
        if (freshProposals.length > 0) {
          for (const proposal of freshProposals) {
            sonnetLog("TEAM", `roster proposal observed for our game_id=${next.gameId}: by=${proposal.did} members=[${proposal.members.join(", ")}]`);
            newRosterProposalsForOwnTeam.push({ did: proposal.did, members: proposal.members, requestId: proposal.requestId });
          }
          next = { ...next, notifiedRosterRequestIds: [...alreadyNotified, ...freshProposals.map((p) => p.requestId)] };
        }
        return next;
      }),
    );
    const [primary, ...rest] = updatedEntries;
    nextState = { ...nextState, team: primary, additionalTeamRequests: rest };
    if (primary?.roomGeneration !== undefined && nextState.phase === "TEAM_REQUESTED") {
      nextState = transition(nextState, "ROOM_ASSIGNED");
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
    ? await maybeAutoSignRoster(agent, contest, config, nextState, scanResult.rosterProposals, client)
    : undefined;
  if (autoSignedRoster) nextState = autoSignedRoster.state;

  const autoProposedWord =
    config.autoWrite && wordResources && nextState.roster?.gameId
      ? await maybeAutoProposeWord(agent, contest, config, nextState.roster, wordResources, client)
      : undefined;

  return {
    state: nextState,
    tick: {
      newlySetUpRooms,
      newlyAcceptedIntoTeams,
      newRosterProposalsForOwnTeam,
      autoSignedRoster: autoSignedRoster?.signed,
      autoProposedWord,
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
  client: TechnocoreClient,
): Promise<{ state: SonnetState; signed?: { gameId: string; requestId: string } } | undefined> {
  if (state.roster) return undefined; // already signed one this contest -- never a second

  const pursuedGameIds = new Set<string>();
  if (state.team) pursuedGameIds.add(state.team.gameId);
  for (const extra of state.additionalTeamRequests ?? []) pursuedGameIds.add(extra.gameId);
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

/**
 * SONNET_AUTO_WRITE's one write path: attempts propose.ts's full pipeline
 * for our locked roster's game_id every tick. propose.ts's own cheap gates
 * (room set up, poem not complete, hash known, we weren't the previous
 * contributor) run and throw BEFORE the LLM call, so a tick where it isn't
 * our turn -- the overwhelming majority of ticks -- costs nothing beyond a
 * room read; only a tick where we're actually eligible spends an OpenAI
 * call. Every ProposeError (not our turn, poem complete, room not ready,
 * model chose outside the candidate set, state went stale mid-flight) is
 * expected, ordinary daemon behavior, not something to alarm on -- logged
 * at PROPOSE, never ERROR.
 */
async function maybeAutoProposeWord(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  roster: NonNullable<SonnetState["roster"]>,
  wordResources: WordResources,
  client: TechnocoreClient,
): Promise<{ gameId: string; word: string; seq?: number } | undefined> {
  if (!roster.gameId) return undefined;
  try {
    const result = await proposeWord(
      agent.identity,
      contest,
      config,
      { gameId: roster.gameId, rosterMembers: roster.members, lexicon: wordResources.lexicon, rhymeIndex: wordResources.rhymeIndex },
      client,
    );
    if (!result.sent) return undefined; // dry-run -- proposeWord already logged the preview
    return { gameId: roster.gameId, word: result.preview.planned.word, seq: result.postedSeq };
  } catch (err) {
    sonnetLog("PROPOSE", `SONNET_AUTO_WRITE: not proposing this tick -- ${err instanceof ProposeError ? err.message : (err as Error).message}`);
    return undefined;
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
  /** Required for SONNET_AUTO_WRITE to do anything -- loaded once by the
   * caller (cmdRun) rather than re-read/re-hashed from disk every tick. */
  wordResources?: WordResources;
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
      const { state: nextState, tick } = await pollOnce(agent, contest, config, state, options.client, options.wordResources);
      state = nextState;
      save(statePath, state);
      sonnetLog(
        "POLL",
        `tick complete: writers=${tick.registeredWriterCount} voters=${tick.registeredVoterCount} pending_team_requests=${tick.pendingTeamRequestCount} ` +
          `newly_set_up=[${tick.newlySetUpRooms.join(", ")}] newly_accepted=[${tick.newlyAcceptedIntoTeams.join(", ")}] new_roster_proposals_for_us=${tick.newRosterProposalsForOwnTeam.length}` +
          (tick.autoSignedRoster ? ` AUTO_SIGNED_ROSTER=${tick.autoSignedRoster.gameId}` : "") +
          (tick.autoProposedWord ? ` AUTO_PROPOSED_WORD=${JSON.stringify(tick.autoProposedWord.word)}(seq=${tick.autoProposedWord.seq})` : ""),
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
