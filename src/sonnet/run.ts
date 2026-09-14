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
import { createTechnocoreClient } from "./http-debug.js";
import type { SonnetAgentIdentity } from "./identity.js";
import type { ContestConfig, SonnetConfig } from "./config.js";
import { scan as scanRooms, toDiscoverySnapshot, type ObservedRoster, type ScanResult } from "./discovery.js";
import { checkRoomSetup } from "./team.js";
import { signRoster, RosterError } from "./roster.js";
import { joinTeamRequest, applyToTeamRequest } from "./recruit.js";
import { proposeWord, ProposeError } from "./propose.js";
import { readFullRoom } from "./room-export.js";
import { tryParseSonnetMessage } from "./protocol.js";
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
  /** game_ids SONNET_AUTO_RECRUIT discovered and applied to THIS tick --
   * every other writer's team-request we hadn't already seen. */
  autoJoinedNewTeams: string[];
  /** Set only when SONNET_AUTO_TEAM signed a roster THIS tick. */
  autoSignedRoster?: { gameId: string; requestId: string };
  /** Set only when SONNET_AUTO_WRITE successfully proposed (and had
   * accepted-by-the-server, per the independent read-back) a word THIS tick. */
  autoProposedWords: Array<{ gameId: string; word: string; seq?: number }>;
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
  client: TechnocoreClient = createTechnocoreClient(config),
  wordResources?: WordResources,
): Promise<{ state: SonnetState; tick: PollTickResult }> {
  const scanResult = await scanRooms(agent.did, contest, config, client);
  let nextState: SonnetState = { ...state, discovery: toDiscoverySnapshot(scanResult) };

  // Every referee receipt addressed to us, keyed by request_id -- the ONLY
  // authoritative accept/reject signal for anything we've sent. Posting
  // successfully (below, and everywhere else in this module) only means the
  // room accepted the bytes; it is never treated as referee confirmation.
  const receiptsByRequestId = new Map(scanResult.ownReceipts.map((r) => [r.requestId, r]));

  // Reconcile OUR OWN registration from what the room actually shows --
  // registration.ts/cli.ts only ever record `state.registration` on the
  // machine that ran `sonnet:register` itself; a fresh environment (a
  // different host, a wiped data/ dir) needs to learn about an
  // already-accepted registration from the room, not just from local
  // bookkeeping, the same way a stale/missing state.json self-heals
  // everywhere else in this module.
  if (!nextState.registration && scanResult.ourRegistration) {
    const observed = scanResult.ourRegistration;
    sonnetLog("STATE", `observed our own existing registration in the room: role=${observed.role} seq=${observed.seq} -- reconciling local state (not yet confirmed by a receipt)`);
    nextState = {
      ...nextState,
      registration: { role: observed.role, requestId: observed.requestId, xAccountUrl: observed.xAccountUrl },
    };
  }
  // Only a real receipt confirms or rejects a registration -- our own post
  // landing is not that signal. Checked every tick until one shows up.
  if (nextState.registration && !nextState.registration.confirmedAtUtc && !nextState.registration.rejectedAtUtc) {
    const receipt = receiptsByRequestId.get(nextState.registration.requestId);
    if (receipt?.status === "accepted") {
      sonnetLog("REGISTER", `CONFIRMED by referee receipt: request_id=${receipt.requestId} seq=${receipt.seq}`);
      nextState = { ...nextState, registration: { ...nextState.registration, confirmedAtUtc: receipt.ts, confirmedSeq: receipt.seq } };
    } else if (receipt?.status === "rejected") {
      sonnetError(
        "ERROR",
        `registration REJECTED by referee: request_id=${receipt.requestId} reason=${receipt.reason ?? "(none given)"} -- ` +
          `everything downstream (team requests, roster, words) will keep failing until this is fixed (re-register with a fresh request_id)`,
      );
      nextState = { ...nextState, registration: { ...nextState.registration, rejectedAtUtc: receipt.ts, rejectedReason: receipt.reason } };
    }
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
    // MUST also exclude dead (rejected) request_ids, not just game_ids still
    // being actively tracked -- otherwise a request the rejection-handling
    // block below just dropped gets "discovered" as untracked again THIS
    // SAME tick (it's still sitting in the room, we sent it), gets re-added
    // to team/additionalTeamRequests, then re-rejected and re-appended to
    // deadTeamRequests next tick, forever: infinite REJECTED-log spam and an
    // ever-growing duplicate deadTeamRequests list. Matched on request_id,
    // not game_id, since a game_id is free to reuse after its own rejection.
    const deadRequestIds = new Set((nextState.deadTeamRequests ?? []).map((d) => d.requestId));
    const knownGameIds = new Set([nextState.team?.gameId, ...(nextState.additionalTeamRequests ?? []).map((t) => t.gameId)].filter((g): g is string => g !== undefined));
    const untracked = scanResult.teamRequests
      .filter((t) => t.did === agent.did && !knownGameIds.has(t.gameId) && !deadRequestIds.has(t.requestId))
      .sort((a, b) => a.seq - b.seq);
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
  const allTeamEntries: TeamEntry[] = [nextState.team, ...(nextState.additionalTeamRequests ?? [])].filter(
    (t): t is TeamEntry => t !== undefined,
  );

  // Drop any entry the referee explicitly REJECTED -- checked BEFORE the
  // room-setup poll below, so a dead game_id doesn't get checked forever.
  // Previously nothing looked at receipts at all here, so a rejection could
  // sit unnoticed indefinitely: pollOnce would just keep polling a room that
  // was never going to be set up, tick after tick, with no log line
  // distinguishing "still waiting" from "already rejected hours ago".
  const newlyDead: NonNullable<SonnetState["deadTeamRequests"]> = [];
  const ownTeamEntries = allTeamEntries.filter((entry) => {
    const receipt = receiptsByRequestId.get(entry.requestId);
    if (receipt?.status !== "rejected") return true;
    sonnetLog(
      "TEAM",
      `REJECTED by referee: game_id=${entry.gameId} request_id=${entry.requestId} reason=${receipt.reason ?? "(none given)"} -- dropping from active tracking`,
    );
    newlyDead.push({ gameId: entry.gameId, requestId: entry.requestId, requestedAtUtc: entry.requestedAtUtc, rejectedAtUtc: receipt.ts, reason: receipt.reason });
    return false;
  });
  if (newlyDead.length > 0) {
    // Defensive de-dup by request_id, belt-and-suspenders alongside the
    // deadRequestIds exclusion above -- never let the same rejection get
    // appended twice even if both guards were somehow bypassed.
    const existingDeadIds = new Set((nextState.deadTeamRequests ?? []).map((d) => d.requestId));
    const freshlyDead = newlyDead.filter((d) => !existingDeadIds.has(d.requestId));
    if (freshlyDead.length > 0) {
      nextState = { ...nextState, deadTeamRequests: [...(nextState.deadTeamRequests ?? []), ...freshlyDead] };
    }
  }

  {
    const updatedEntries = await Promise.all(
      ownTeamEntries.map(async (entry) => {
        let next: typeof entry | null = entry;
        if (next.roomGeneration === undefined) {
          // A single malformed/oversized game_id (e.g. scraped from someone
          // else's free-text message) must never abort the whole tick --
          // confirmed live: one bad entry threw inside Promise.all here,
          // which failed the entire pollOnce call, which skipped saveState
          // for that tick entirely, silently discarding every OTHER real
          // update (including a genuine roster acceptance) tick after tick.
          try {
            const setup = await checkRoomSetup(contest, config, next.gameId, client);
            if (setup.hasMessages) {
              sonnetLog("TEAM", `our requested room is now set up: game_id=${next.gameId} generation=${setup.generation}`);
              next = { ...next, room: setup.room, roomGeneration: setup.generation };
              newlySetUpRooms.push(next.gameId);
            }
          } catch (err) {
            // See the identical check in the pendingJoinInterests loop below
            // -- a RangeError means the game_id fails format validation
            // permanently, so retrying it every tick forever is pointless.
            if (err instanceof RangeError) {
              sonnetError("ERROR", `our own game_id=${next.gameId} is permanently invalid: ${err.message} -- dropping, will never retry`);
              return null;
            }
            sonnetError("ERROR", `checkRoomSetup failed for our own game_id=${next.gameId}: ${(err as Error).message} -- skipping this entry for this tick`);
          }
        }
        if (next === null) return null; // unreachable in practice (the RangeError branch above already returned) -- satisfies control-flow narrowing
        const confirmed = next; // `const` so it stays narrowed non-null inside the closures below (a `let` doesn't)

        // Anyone proposing sonnet.roster.v1 for this game_id is the "someone
        // wants to join" signal -- announce each one exactly once.
        const alreadyNotified = new Set(confirmed.notifiedRosterRequestIds ?? []);
        const freshProposals = scanResult.rosterProposals.filter((r) => r.gameId === confirmed.gameId && !alreadyNotified.has(r.requestId));
        if (freshProposals.length > 0) {
          for (const proposal of freshProposals) {
            sonnetLog("TEAM", `roster proposal observed for our game_id=${confirmed.gameId}: by=${proposal.did} members=[${proposal.members.join(", ")}]`);
            newRosterProposalsForOwnTeam.push({ did: proposal.did, members: proposal.members, requestId: proposal.requestId });
          }
          return { ...confirmed, notifiedRosterRequestIds: [...alreadyNotified, ...freshProposals.map((p) => p.requestId)] };
        }
        return confirmed;
      }),
    );
    const [primary, ...rest] = updatedEntries.filter((e): e is NonNullable<typeof e> => e !== null);
    nextState = { ...nextState, team: primary, additionalTeamRequests: rest };
    if (primary?.roomGeneration !== undefined && nextState.phase === "TEAM_REQUESTED") {
      nextState = transition(nextState, "ROOM_ASSIGNED");
    }
  }

  if (nextState.pendingJoinInterests && nextState.pendingJoinInterests.length > 0) {
    const updated = await Promise.all(
      nextState.pendingJoinInterests.map(async (interest) => {
        let next: typeof interest | null = interest;
        if (!next.roomSetUpAtUtc) {
          // Same isolation as the ownTeamEntries loop above -- one bad
          // game_id here must not abort the tick and lose every other
          // pendingJoinInterests update (including a real acceptance).
          try {
            const setup = await checkRoomSetup(contest, config, interest.gameId, client);
            if (setup.hasMessages) {
              sonnetLog("TEAM", `a room we're interested in is now set up: game_id=${interest.gameId} generation=${setup.generation} -- checking whether its roster includes us`);
              newlySetUpRooms.push(interest.gameId);
              next = { ...next, roomSetUpAtUtc: new Date().toISOString() };
            }
          } catch (err) {
            // A game_id that fails FORMAT validation (RangeError, from
            // sonnetRooms()/protocol.ts) is a permanent, structural fact --
            // no future tick will ever make it valid. Confirmed live:
            // without dropping it here, two such entries logged this exact
            // error every single tick, forever (one scraped from someone
            // else's free-text message was too long/malformed to ever be a
            // real room). A transient error (network, room legitimately not
            // set up yet) is anything else -- keep retrying those.
            if (err instanceof RangeError) {
              sonnetError("ERROR", `pending join-interest game_id=${interest.gameId} is permanently invalid: ${err.message} -- dropping, will never retry`);
              return null;
            }
            sonnetError("ERROR", `checkRoomSetup failed for pending join-interest game_id=${interest.gameId}: ${(err as Error).message} -- skipping this entry for this tick`);
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
    nextState = { ...nextState, pendingJoinInterests: updated.filter((i): i is NonNullable<typeof i> => i !== null) };
  }

  const newlyDiscoveredAndApplied = config.autoRecruit
    ? await maybeAutoJoinNewTeams(agent, contest, config, nextState, scanResult, client)
    : undefined;
  if (newlyDiscoveredAndApplied) nextState = newlyDiscoveredAndApplied.state;

  // Same receipt-confirmation discipline as registration/team-requests:
  // sending our own sonnet.roster.v1 successfully only means the room
  // accepted the bytes, never that the referee validated it. If rejected
  // (duplicate signer, unregistered member, stale generation, ...), clear
  // `roster` back to undefined so a candidate can be promoted in its place.
  if (nextState.roster && !nextState.roster.rejectedAtUtc && !nextState.roster.frozenAtUtc) {
    const receipt = receiptsByRequestId.get(nextState.roster.requestId);
    if (receipt?.status === "rejected") {
      sonnetError(
        "ERROR",
        `roster signature REJECTED by referee: game_id=${nextState.roster.gameId} request_id=${receipt.requestId} reason=${receipt.reason ?? "(none given)"} -- clearing local lock so a different roster can be promoted`,
      );
      nextState = { ...nextState, roster: undefined };
    }
  }
  if (nextState.additionalRosters && nextState.additionalRosters.length > 0) {
    const survivingRosters = nextState.additionalRosters.filter((r) => {
      if (r.rejectedAtUtc || r.frozenAtUtc) return true;
      const receipt = receiptsByRequestId.get(r.requestId);
      if (receipt?.status !== "rejected") return true;
      sonnetError("ERROR", `roster signature REJECTED by referee: game_id=${r.gameId} request_id=${receipt.requestId} reason=${receipt.reason ?? "(none given)"} -- dropping`);
      return false;
    });
    if (survivingRosters.length !== nextState.additionalRosters.length) {
      nextState = { ...nextState, additionalRosters: survivingRosters };
    }
  }

  // Drop any signed-but-not-yet-promoted candidate the referee explicitly
  // rejected -- it was our own send, so a receipt for it (if any) is
  // addressed to us and already in receiptsByRequestId. Also permanently
  // remembers the CONTENT (game_id/room_generation/members) of anything
  // rejected here -- confirmed live this matters: our own rejected post
  // reappears on the very next scan as a brand-new ObservedRoster (same
  // content, a fresh request_id we never generated ourselves so it was
  // never in autoSignAttemptedRequestIds), and once it's dropped from
  // rosterCandidates the OLD content-only dedup in maybeAutoSignRoster (which
  // reads off the CURRENT rosterCandidates) has nothing left to compare
  // against -- so it looked "new" again, got re-signed, re-rejected
  // (`reason=roster: member already frozen`, a PERMANENT fact -- retrying
  // never succeeds), forever, once per tick.
  if (nextState.rosterCandidates && nextState.rosterCandidates.length > 0) {
    const newlyRejectedKeys: string[] = [];
    const surviving = nextState.rosterCandidates.filter((c) => {
      const receipt = receiptsByRequestId.get(c.requestId);
      if (receipt?.status !== "rejected") return true;
      sonnetLog("ROSTER", `candidate REJECTED by referee: game_id=${c.gameId} request_id=${c.requestId} reason=${receipt.reason ?? "(none given)"} -- dropping`);
      newlyRejectedKeys.push(`${c.gameId}|${c.roomGeneration}|${[...c.members].sort().join(",")}`);
      return false;
    });
    if (surviving.length !== nextState.rosterCandidates.length) {
      nextState = {
        ...nextState,
        rosterCandidates: surviving,
        rejectedRosterContentKeys: [...new Set([...(nextState.rejectedRosterContentKeys ?? []), ...newlyRejectedKeys])],
      };
    }
  }

  // Self-heal duplicate candidates accumulated by an older build's re-sign
  // loop (fixed in maybeAutoSignRoster, but state.json persisted from before
  // the fix can still carry many identical entries for the same content,
  // each with its own request_id) -- collapse to one per distinct
  // game_id/room_generation/members, keeping the earliest-signed. Without
  // this, the promotion loop below re-reads the SAME poem room once per
  // leftover duplicate, every tick, forever.
  if (nextState.rosterCandidates && nextState.rosterCandidates.length > 1) {
    const seen = new Map<string, (typeof nextState.rosterCandidates)[number]>();
    for (const c of nextState.rosterCandidates) {
      const key = `${c.gameId}|${c.roomGeneration}|${[...c.members].sort().join(",")}`;
      const existing = seen.get(key);
      if (!existing || c.signedAtUtc < existing.signedAtUtc) seen.set(key, c);
    }
    const deduped = [...seen.values()];
    if (deduped.length !== nextState.rosterCandidates.length) {
      sonnetLog("ROSTER", `collapsed ${nextState.rosterCandidates.length - deduped.length} duplicate roster candidate(s) (same content, different request_id) down to ${deduped.length}`);
      nextState = { ...nextState, rosterCandidates: deduped };
    }
  }

  // Promote EVERY pending candidate whose poem room shows real
  // sonnet.word.v1 activity -- the only unambiguous "this one actually
  // locked" signal (the referee's roster_ready receipt is addressed to
  // whichever signer completed the set, which usually isn't us, so it
  // can't be matched via our own receipts). Downstream (maybeAutoProposeWord
  // and propose.ts's own turn/hash checks) never acts wrongly even if this
  // promotion is ever wrong, since a mismatched roster just fails to find a
  // legal turn for us -- so this heuristic is safe to run unconditionally.
  // A contributor can be genuinely, validly locked into several DIFFERENT
  // poems (game_ids) at once, so this no longer stops at the first one --
  // the first promotion in a tick fills `roster`, every one after that
  // (this tick or a later one) is appended to `additionalRosters`, skipping
  // a game_id already locked either place.
  if (nextState.rosterCandidates && nextState.rosterCandidates.length > 0) {
    const originalCandidates = nextState.rosterCandidates;
    const stillPending: NonNullable<typeof nextState.rosterCandidates> = [];
    const lockedGameIds = new Set<string>([nextState.roster?.gameId, ...(nextState.additionalRosters ?? []).map((r) => r.gameId)].filter((g): g is string => !!g));
    for (const candidate of originalCandidates) {
      if (lockedGameIds.has(candidate.gameId)) continue; // already locked via a different candidate for the same game_id
      let started = false;
      try {
        started = await poemRoomHasWordActivity(client, candidate.poemRoom);
      } catch (err) {
        sonnetError("ERROR", `checking word activity failed for candidate game_id=${candidate.gameId}: ${(err as Error).message} -- skipping this tick`);
        stillPending.push(candidate);
        continue;
      }
      if (!started) {
        stillPending.push(candidate);
        continue;
      }
      const promoted = { members: candidate.members, requestId: candidate.requestId, signedAtUtc: candidate.signedAtUtc, gameId: candidate.gameId };
      if (!nextState.roster) {
        sonnetLog("ROSTER", `PROMOTED candidate to active roster: game_id=${candidate.gameId} -- its poem room already has word activity`);
        nextState = { ...nextState, roster: promoted };
      } else {
        sonnetLog("ROSTER", `PROMOTED candidate to an ADDITIONAL active roster (writing in multiple poems at once): game_id=${candidate.gameId} -- its poem room already has word activity`);
        nextState = { ...nextState, additionalRosters: [...(nextState.additionalRosters ?? []), promoted] };
      }
      lockedGameIds.add(candidate.gameId);
    }
    if (stillPending.length !== originalCandidates.length) {
      nextState = { ...nextState, rosterCandidates: stillPending };
    }
  }

  // As INITIATOR of our own team-request(s), auto-signing alone is never
  // enough -- nobody else proposes a roster for a room we started, they just
  // apply to it (sonnet.application.v1) and wait for US to build and post
  // one. Confirmed live this was a real, undetected gap: 3+ real applicants
  // sat unanswered on flopagent-s2d for 8+ hours because nothing ever
  // proposed a roster from them; it took a manual one-off script.
  const autoProposedOwnRoster = config.autoTeam
    ? await maybeAutoProposeOwnRoster(agent, contest, config, nextState, scanResult, client)
    : undefined;
  if (autoProposedOwnRoster) nextState = autoProposedOwnRoster.state;

  const autoSignedRoster = config.autoTeam
    ? await maybeAutoSignRoster(agent, contest, config, nextState, scanResult.rosterProposals, client)
    : undefined;
  if (autoSignedRoster) nextState = autoSignedRoster.state;

  // One attempt per ACTIVE roster, every tick -- a contributor can be
  // genuinely locked into several different poems at once (see
  // maybeAutoSignRoster's header), and each attempt is cheap when it isn't
  // that poem's turn (propose.ts throws before ever spending an LLM call),
  // so there's no reason to write in only one of them.
  const activeRosters = [nextState.roster, ...(nextState.additionalRosters ?? [])].filter(
    (r): r is NonNullable<typeof nextState.roster> => !!r?.gameId,
  );
  const autoProposedWords: Array<{ gameId: string; word: string; seq?: number }> = [];
  if (config.autoWrite && wordResources) {
    for (const roster of activeRosters) {
      const result = await maybeAutoProposeWord(agent, contest, config, roster, wordResources, client);
      if (result) autoProposedWords.push(result);
    }
  }

  return {
    state: nextState,
    tick: {
      newlySetUpRooms,
      newlyAcceptedIntoTeams,
      newRosterProposalsForOwnTeam,
      autoJoinedNewTeams: newlyDiscoveredAndApplied?.joined ?? [],
      autoSignedRoster: autoSignedRoster?.signed,
      autoProposedWords,
      registeredWriterCount: scanResult.registrations.filter((r) => r.role === "writer").length,
      registeredVoterCount: scanResult.registrations.filter((r) => r.role === "voter").length,
      pendingTeamRequestCount: scanResult.teamRequests.length,
    },
  };
}

/**
 * SONNET_AUTO_RECRUIT's write path: every OTHER writer's team-request we
 * haven't already seen (not in team/additionalTeamRequests/deadTeamRequests/
 * pendingJoinInterests/rosterCandidates/roster) gets a join-interest AND a
 * sonnet.application.v1 -- sent together (see recruit.ts's
 * applyToTeamRequest), since sonnet-game.md defines no format for this and
 * both are only ever a best-effort attempt to be noticed by whoever's
 * actually running that team. Capped per tick only as a sanity limit
 * against a burst; in practice scanResult.teamRequests already reflects
 * just the currently-visible room window, so a normal tick sees a handful
 * of genuinely new ones at most.
 */
const MAX_AUTO_JOINS_PER_TICK = 25;

async function maybeAutoJoinNewTeams(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  state: SonnetState,
  scanResult: ScanResult,
  client: TechnocoreClient,
): Promise<{ state: SonnetState; joined: string[] }> {
  const known = new Set<string>();
  if (state.team) known.add(state.team.gameId);
  for (const t of state.additionalTeamRequests ?? []) known.add(t.gameId);
  for (const t of state.deadTeamRequests ?? []) known.add(t.gameId);
  for (const i of state.pendingJoinInterests ?? []) known.add(i.gameId);
  for (const c of state.rosterCandidates ?? []) known.add(c.gameId);
  if (state.roster?.gameId) known.add(state.roster.gameId);
  for (const r of state.additionalRosters ?? []) if (r.gameId) known.add(r.gameId);

  const fresh = new Map<string, string>(); // gameId -> requester DID (first seen)
  for (const t of scanResult.teamRequests) {
    if (t.did === agent.did || known.has(t.gameId) || fresh.has(t.gameId)) continue;
    fresh.set(t.gameId, t.did);
  }
  const targets = [...fresh.entries()].slice(0, MAX_AUTO_JOINS_PER_TICK);
  if (targets.length === 0) return { state, joined: [] };

  let nextState = state;
  const joined: string[] = [];
  for (const [gameId, requesterDid] of targets) {
    try {
      const result = await joinTeamRequest(agent.identity, contest, config, gameId, requesterDid, { minIntervalMs: 0 }, client);
      if (result.sent) {
        nextState = { ...nextState, pendingJoinInterests: [...(nextState.pendingJoinInterests ?? []), { gameId, requesterDid, sentAtUtc: new Date().toISOString() }] };
        joined.push(gameId);
      }
      await applyToTeamRequest(agent.identity, contest, config, gameId, { minIntervalMs: 0 }, client);
    } catch (err) {
      sonnetError("ERROR", `SONNET_AUTO_RECRUIT: failed for newly discovered game_id=${gameId}: ${(err as Error).message} -- will retry next tick`);
    }
  }
  if (joined.length > 0) {
    sonnetLog("TEAM", `SONNET_AUTO_RECRUIT: applied to ${joined.length} newly discovered game_id(s): [${joined.join(", ")}]`);
  }
  return { state: nextState, joined };
}

interface RosterSignCandidate {
  gameId: string;
  proposal: ObservedRoster;
}

const MIN_APPLICANTS_TO_PROPOSE_OWN_ROSTER = 3; // + us = 4, the protocol minimum
const MAX_ROSTER_MEMBERS = 8;

/**
 * SONNET_AUTO_TEAM's write path for a room WE started (state.team /
 * additionalTeamRequests): auto-signing alone never proposes anything for
 * these, since nobody else initiates a roster for a room they didn't
 * create -- they just apply (sonnet.application.v1) and wait. Once a
 * game_id's room is set up and at least 3 OTHER writers have applied to it
 * (4 total, the protocol minimum), build [ourDid, ...applicants] (capped at
 * 8) and post it ourselves. Proposed at most once per game_id ever
 * (`autoProposedOwnRosterGameIds`), regardless of outcome -- a rejection
 * doesn't retry with a different applicant subset automatically; that's a
 * judgment call about WHICH applicants to drop, not something safe to
 * automate blindly.
 *
 * Selects applicants in first-seen order (earliest sonnet.application.v1
 * first) -- simple and predictable, not an attempt to optimize for DID
 * letter coverage or anything else that would need re-litigating every time
 * the applicant pool changes.
 */
async function maybeAutoProposeOwnRoster(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  state: SonnetState,
  scanResult: ScanResult,
  client: TechnocoreClient,
): Promise<{ state: SonnetState; proposed?: { gameId: string; requestId: string } } | undefined> {
  type TeamEntry = NonNullable<SonnetState["team"]>;
  const ownEntries: TeamEntry[] = [state.team, ...(state.additionalTeamRequests ?? [])].filter((t): t is TeamEntry => t !== undefined);
  const alreadyProposed = new Set(state.autoProposedOwnRosterGameIds ?? []);

  for (const entry of ownEntries) {
    if (entry.roomGeneration === undefined || !entry.room) continue; // room not set up yet
    if (alreadyProposed.has(entry.gameId)) continue;

    const applicantDids = [
      ...new Set(
        scanResult.applications
          .filter((a) => a.gameId === entry.gameId && a.did !== agent.did)
          .sort((a, b) => a.seq - b.seq)
          .map((a) => a.did),
      ),
    ];
    if (applicantDids.length < MIN_APPLICANTS_TO_PROPOSE_OWN_ROSTER) continue;

    const members = [agent.did, ...applicantDids.slice(0, MAX_ROSTER_MEMBERS - 1)];
    sonnetLog("ROSTER", `SONNET_AUTO_TEAM: proposing our own roster for game_id=${entry.gameId} with ${members.length} members (from ${applicantDids.length} applicant(s))`);

    const proposedIds = [...alreadyProposed, entry.gameId];
    try {
      const result = await signRoster(
        agent.identity,
        contest,
        config,
        { gameId: entry.gameId, poemRoom: entry.room, roomGeneration: entry.roomGeneration, members },
        scanResult.rosterProposals,
        client,
      );
      if (!result.sent) return undefined; // SONNET_DRY_RUN -- don't mark attempted, retry for real later
      const nextState: SonnetState = {
        ...state,
        autoProposedOwnRosterGameIds: proposedIds,
        rosterCandidates: [
          ...(state.rosterCandidates ?? []),
          { gameId: entry.gameId, poemRoom: entry.room, roomGeneration: entry.roomGeneration, members, requestId: result.preview.payload.request_id, signedAtUtc: new Date().toISOString() },
        ],
      };
      return { state: nextState, proposed: { gameId: entry.gameId, requestId: result.preview.payload.request_id } };
    } catch (err) {
      sonnetLog("CONFLICT", `SONNET_AUTO_TEAM: not proposing our own roster for game_id=${entry.gameId} -- ${err instanceof RosterError ? err.message : (err as Error).message}`);
      return { state: { ...state, autoProposedOwnRosterGameIds: proposedIds } };
    }
  }
  return undefined;
}

/**
 * SONNET_AUTO_TEAM's write path: among every currently-observed roster
 * proposal that (a) includes our own DID and (b) has a valid 4-8 member
 * count, sign the FIRST ONE not yet attempted per tick -- "Each contributor
 * may have one current roster consent for an unfinished poem" (sonnet-game.md)
 * is scoped PER POEM (game_id), not globally, so this signs across as many
 * DIFFERENT game_ids as show up, one per tick, and never retries a
 * request_id it already attempted (successfully or not), so a standing
 * conflict doesn't spam a sign attempt every tick forever. The one-per-poem
 * rule is still enforced -- detectRosterConflict (roster.ts) refuses to sign
 * a SECOND different composition for a game_id we're already committed to.
 * Still fully subject to SONNET_DRY_RUN -- this only ever
 * builds+locally-verifies+confirms when dry-run is off, same as every other
 * write path here.
 *
 * Deliberately NOT gated on "a game_id we're actually pursuing" (our own
 * team-request or a join interest we sent) -- confirmed live that another
 * writer can add our DID to their own roster draft without us ever having
 * sent a team-request or join-interest for that game_id (observed: game_id
 * "echowrites", roster version echo-roster-v4-1789170722, included our DID
 * even though we'd never touched that game_id -- the pursuedGameIds gate
 * that used to be here would have silently ignored it forever). Our own DID
 * being a member IS the pursuit signal; requiring anything more just means
 * missing real invitations.
 *
 * Also refuses a proposal with duplicate DIDs in `members` -- a cheap sanity
 * check against a malformed draft, since a candidate wastes our one-time
 * sign attempt for the whole contest if it turns out to be garbage (paired
 * with pollOnce's receipt-based rejection handling above, which unlocks
 * `state.roster` again if the referee itself rejects a signed one).
 *
 * Deliberately does NOT cross-check that every member is a currently
 * "registered writer" per our own scan: the registration room is a bounded
 * retention ring under heavy churn (confirmed live: tens of thousands of
 * voter registrations rotated the window from seq ~11675 to ~83000+ within
 * 14 hours), so a genuinely-registered writer's own registration message
 * can already have rolled off it -- rejecting a real, valid roster candidate
 * for that reason would be actively counterproductive. The referee itself
 * enforces this server-side; if it rejects our sign attempt for exactly
 * that reason, pollOnce's receipt handling above unlocks and retries.
 */
async function maybeAutoSignRoster(
  agent: SonnetAgentIdentity,
  contest: ContestConfig,
  config: SonnetConfig,
  state: SonnetState,
  rosterProposals: readonly ObservedRoster[],
  client: TechnocoreClient,
): Promise<{ state: SonnetState; signed?: { gameId: string; requestId: string } } | undefined> {
  // A contributor may be locked into several DIFFERENT poems (game_ids) at
  // once -- see this function's header. What's still never allowed is a
  // SECOND, different composition for a game_id already locked (roster or
  // additionalRosters): skip those game_ids here as a cheap pre-filter;
  // detectRosterConflict (roster.ts) would refuse them anyway, but there's
  // no reason to spend a sign attempt (and a CONFLICT log line) on it.
  const lockedGameIds = new Set<string>(
    [state.roster?.gameId, ...(state.additionalRosters ?? []).map((r) => r.gameId)].filter((g): g is string => !!g),
  );

  const pursuedGameIds = new Set<string>();
  if (state.team) pursuedGameIds.add(state.team.gameId);
  for (const extra of state.additionalTeamRequests ?? []) pursuedGameIds.add(extra.gameId);
  for (const interest of state.pendingJoinInterests ?? []) pursuedGameIds.add(interest.gameId);

  // Never re-sign a request_id already attempted (success, conflict, or
  // rejection) -- includes both the legacy single `roster.requestId` (kept
  // for backward-compatible state.json shapes) and every still-pending
  // `rosterCandidates` entry.
  const alreadyAttempted = new Set(state.autoSignAttemptedRequestIds ?? []);

  // Content-based dedup, independent of request_id: OUR OWN prior countersign
  // of a proposal re-appears on the next scan as a brand-new ObservedRoster
  // (same game_id/room_generation/members, but a freshly generated
  // request_id we never added to `alreadyAttempted`) -- without this check
  // that self-observation looks like a fresh, never-attempted candidate and
  // gets re-signed forever, spamming the discovery room with an identical
  // roster.v1 every tick. Keyed on room_generation too, so a real resetup
  // (which legitimately produces a new roster context) is still signable.
  const alreadySignedContent = new Set(
    (state.rosterCandidates ?? []).map((c) => `${c.gameId}|${c.roomGeneration}|${[...c.members].sort().join(",")}`),
  );
  // PERMANENT memory of content the referee has already explicitly rejected
  // (see state.ts's rejectedRosterContentKeys) -- unlike alreadySignedContent
  // above, this never forgets just because the rejected candidate got
  // dropped from rosterCandidates. A rejection reason like "member already
  // frozen" is a fact that never changes, so this composition can never
  // legitimately succeed; without this, it re-appears as a "new" observation
  // (our own rejected post, under a fresh request_id) and gets re-signed,
  // re-rejected, forever, once per tick.
  const permanentlyRejectedContent = new Set(state.rejectedRosterContentKeys ?? []);
  const candidates: RosterSignCandidate[] = rosterProposals
    .filter((p) => {
      const contentKey = `${p.gameId}|${p.roomGeneration}|${[...p.members].sort().join(",")}`;
      return (
        p.members.includes(agent.did) &&
        p.members.length >= 4 &&
        p.members.length <= 8 &&
        new Set(p.members).size === p.members.length &&
        !lockedGameIds.has(p.gameId) &&
        !alreadyAttempted.has(p.requestId) &&
        !alreadySignedContent.has(contentKey) &&
        !permanentlyRejectedContent.has(contentKey)
      );
    })
    .map((proposal) => ({ gameId: proposal.gameId, proposal }))
    .sort((a, b) => a.proposal.seq - b.proposal.seq);

  const candidate = candidates[0];
  if (!candidate) return undefined;

  sonnetLog(
    "ROSTER",
    `SONNET_AUTO_TEAM: attempting to sign observed roster for game_id=${candidate.gameId} members=[${candidate.proposal.members.join(", ")}]` +
      (pursuedGameIds.has(candidate.gameId) ? "" : " (a game_id we never explicitly pursued -- someone else added us)") +
      (state.rosterCandidates?.length ? ` (already have ${state.rosterCandidates.length} other candidate(s) pending -- signing this one too, as a hedge)` : ""),
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
    // NOT promoted to `roster` yet -- most signed candidates never actually
    // lock (the other signers scatter across many competing teams), so
    // committing here would repeat the old single-commitment bug. pollOnce's
    // promotion step moves this to `roster` once its poem room shows real
    // word activity; until then it just sits alongside any other pending
    // candidates as one more hedge.
    let nextState: SonnetState = {
      ...state,
      autoSignAttemptedRequestIds: attempted,
      rosterCandidates: [
        ...(state.rosterCandidates ?? []),
        { gameId: candidate.gameId, poemRoom: candidate.proposal.poemRoom, roomGeneration: candidate.proposal.roomGeneration, members: candidate.proposal.members, requestId: result.preview.payload.request_id, signedAtUtc: new Date().toISOString() },
      ],
    };
    if (nextState.phase === "ROOM_ASSIGNED") nextState = transition(nextState, "ROSTER_PENDING");
    return { state: nextState, signed: { gameId: candidate.gameId, requestId: result.preview.payload.request_id } };
  } catch (err) {
    sonnetLog("CONFLICT", `SONNET_AUTO_TEAM: not signing game_id=${candidate.gameId} -- ${err instanceof RosterError ? err.message : (err as Error).message}`);
    return { state: { ...state, autoSignAttemptedRequestIds: attempted } };
  }
}

/** Reads a poem room and checks whether any sonnet.word.v1 has ever been
 * posted there -- the only unambiguous "this roster actually locked" signal
 * (per sonnet-game.md, the roster freezes atomically on the first accepted
 * word). Deliberately does not attempt to verify the word was ACCEPTED
 * (that would need a referee receipt cross-reference); a rejected first
 * attempt still proves the room is live and someone is writing in it, which
 * is exactly the promotion signal this needs. */
async function poemRoomHasWordActivity(client: TechnocoreClient, poemRoom: string): Promise<boolean> {
  const { messages } = await readFullRoom(client, poemRoom);
  return messages.some((m) => tryParseSonnetMessage(m.text)?.type === "sonnet.word.v1");
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
          (tick.autoJoinedNewTeams.length ? ` AUTO_JOINED=[${tick.autoJoinedNewTeams.join(", ")}]` : "") +
          (tick.autoSignedRoster ? ` AUTO_SIGNED_ROSTER=${tick.autoSignedRoster.gameId}` : "") +
          (tick.autoProposedWords.length ? tick.autoProposedWords.map((w) => ` AUTO_PROPOSED_WORD[${w.gameId}]=${JSON.stringify(w.word)}(seq=${w.seq})`).join("") : ""),
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
