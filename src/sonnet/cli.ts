#!/usr/bin/env node
/**
 * `npm run sonnet:<command> -- [flags]` -- argv/stdio glue only, same
 * discipline as ../cli.ts: no protocol logic lives here, only argument
 * parsing and calls into the sonnet/ modules.
 */

import { IdentityError } from "../identity.js";
import { TechnocoreError } from "../technocore.js";
import { loadContestConfig, loadSonnetConfig, SonnetConfigError } from "./config.js";
import { loadSonnetIdentity, SonnetIdentityError } from "./identity.js";
import { loadDictionary, CmudictError } from "./cmudict.js";
import { loadRhymeIndex } from "./rhyme.js";
import { buildDidWordCache, type DidWordCache } from "./did-words.js";
import { checkEligibility } from "./eligibility.js";
import { scan as scanRooms, toDiscoverySnapshot } from "./discovery.js";
import { buildRegistrationPreview, register, RegistrationError } from "./registration.js";
import { buildRecruitPreview, buildJoinInterestPreview, recruit, joinTeamRequest, RecruitError } from "./recruit.js";
import { buildTeamRequestPreview, checkRoomSetup, requestTeam, TeamError } from "./team.js";
import { buildRosterPreview, detectRosterConflict, signRoster, summarizeRosterSigners, RosterError } from "./roster.js";
import { loadState, saveState, transition } from "./state.js";
import { runLoop } from "./run.js";
import { readJsonFile, writeJsonFileAtomic } from "./persistence.js";
import { sonnetLog, sonnetError } from "./logger.js";
import { GAME_ID_PATTERN, sonnetRooms, type SonnetRole } from "./protocol.js";
import { DID_PATTERN } from "../identity.js";

const USAGE = `flop-agent sonnet -- Technocore Sonnet Contest agent (Agent A only)

Usage:
  npm run sonnet:preflight
  npm run sonnet:scan
  npm run sonnet:register -- [--dry-run] --role writer --x-account https://x.com/handle
  npm run sonnet:register -- [--dry-run] --role voter
  npm run sonnet:register -- [--dry-run] --role organizer
  npm run sonnet:recruit -- [--dry-run]
  npm run sonnet:join -- [--dry-run] --game-id <id> --requester-did did:key:...
  npm run sonnet:team -- [--dry-run] --game-id <id>
  npm run sonnet:roster -- [--dry-run] --game-id <id> --members did:key:...,did:key:...
  npm run sonnet:run
`;

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function getOrBuildWordCache(
  config: ReturnType<typeof loadSonnetConfig>,
  did: string,
  identityPath: string,
  dictionarySha256: string,
  lexicon: Parameters<typeof buildDidWordCache>[0]["lexicon"],
): DidWordCache {
  const existing = readJsonFile<DidWordCache>(config.wordCachePath);
  if (existing && existing.did === did && existing.dictionarySha256 === dictionarySha256) {
    sonnetLog("CANDIDATES", `word cache at ${config.wordCachePath} is up to date (did/dictionary unchanged) -- reusing it`);
    return existing;
  }
  sonnetLog("CANDIDATES", "rebuilding DID word cache...");
  const rhymeIndex = loadRhymeIndex(config);
  const cache = buildDidWordCache({ did, identityPath, dictionarySha256, lexicon, rhymeIndex });
  writeJsonFileAtomic(config.wordCachePath, cache);
  sonnetLog("CANDIDATES", `wrote ${config.wordCachePath} (${cache.totalValidWords} valid words)`);
  return cache;
}

async function cmdPreflight(): Promise<void> {
  const P = (line: string) => sonnetLog("PREFLIGHT", line);
  P("");
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const nowUtc = new Date().toISOString();

  P(`contest id: ${contest.contest_id} (rules_version ${contest.rules_version})`);
  P(`current UTC time: ${nowUtc}`);
  P(`contest start (opening): ${contest.opening}`);
  P(`contest end (deadline): ${contest.deadline}`);

  let did: string | undefined;
  let identityPath = "";
  let signingAvailable = false;
  try {
    const agent = loadSonnetIdentity();
    did = agent.did;
    identityPath = agent.identityPath;
    // Signing a throwaway local string proves the key loads and works,
    // without ever printing anything derived from the seed itself.
    agent.identity.sign("sonnet-preflight-self-test");
    signingAvailable = true;
    P(`Agent A DID: ${did}`);
    P(`identity file used: ${identityPath}`);
    P("signing available: yes");
  } catch (err) {
    P(`identity file used: ${process.env.TECHNOCORE_IDENTITY_PATH?.trim() || ".technocore/identity.json"}`);
    P("signing available: no");
    P(`problem: ${(err as Error).message}`);
  }

  P(`eligibility cutoff: ${contest.identity_cutoff}`);

  if (did) {
    try {
      const eligibility = await checkEligibility(did, contest, config);
      if (eligibility.evidence) {
        P(
          `pre-start signed evidence found: yes (room=${eligibility.evidence.room} seq=${eligibility.evidence.seq} ts=${eligibility.evidence.ts})`,
        );
      } else {
        P("pre-start signed evidence found: no (see limitations below)");
      }
      P(`eligible as writer: ${eligibility.status}`);
      P(`eligible as voter: ${eligibility.status}`);
      P(`eligibility checked rooms: ${eligibility.checkedRooms.join(", ") || "(none)"}`);
      for (const limitation of eligibility.limitations) P(`eligibility limitation: ${limitation}`);
    } catch (err) {
      P(`eligible as writer: unknown`);
      P(`eligible as voter: unknown`);
      P(`problem: eligibility check failed: ${(err as Error).message}`);
    }
  } else {
    P("eligible as writer: unknown (no identity loaded)");
    P("eligible as voter: unknown (no identity loaded)");
  }

  if (did && signingAvailable) {
    try {
      const { lexicon, sha256 } = loadDictionary(config);
      P(`dictionary loaded: ${lexicon.size} words, sha256=${sha256} (matches vendor/technocore-sonnet/upstream.json)`);
      const cache = getOrBuildWordCache(config, did, identityPath, sha256, lexicon);
      P(`CMUdict-compatible words for this DID: ${cache.totalValidWords}`);
      P(
        `syllable distribution: 1=${cache.bySyllableCount["1"]} 2=${cache.bySyllableCount["2"]} 3=${cache.bySyllableCount["3"]} 4+=${cache.bySyllableCount["4+"]}`,
      );
      P(`potential rhyme-ending words (heuristic, not an official rule): ${cache.potentialRhymeEndingWords}`);
    } catch (err) {
      P(`problem: dictionary/word-cache step failed: ${(err as Error).message}`);
    }
  } else {
    P("CMUdict-compatible word count: skipped (no usable identity)");
  }

  P("");
}

async function cmdScan(): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();

  sonnetLog("DISCOVERY", `scanning official rooms for contest_id=${contest.contest_id}...`);
  const result = await scanRooms(agent.did, contest, config);

  sonnetLog("DISCOVERY", `rules room read: ${result.rulesRoomRead ? "yes" : "no"}${result.refereeDid ? ` (candidate referee DID: ${result.refereeDid})` : ""}`);
  sonnetLog("DISCOVERY", `registered writers: ${result.registrations.filter((r) => r.role === "writer").length}`);
  for (const r of result.registrations.filter((r) => r.role === "writer")) {
    sonnetLog("DISCOVERY", `  writer ${r.did} x_account=${r.xAccountUrl ?? "(none)"} seq=${r.seq}`);
  }
  sonnetLog("DISCOVERY", `registered voters: ${result.registrations.filter((r) => r.role === "voter").length}`);
  sonnetLog("DISCOVERY", `registered organizers: ${result.registrations.filter((r) => r.role === "organizer").length}`);
  sonnetLog("DISCOVERY", `our registration status: ${result.ourRegistration ? `${result.ourRegistration.role} (request_id=${result.ourRegistration.requestId}, seq=${result.ourRegistration.seq})` : "not registered"}`);
  sonnetLog("DISCOVERY", `pending team requests: ${result.teamRequests.length}`);
  for (const t of result.teamRequests) sonnetLog("DISCOVERY", `  team-request game_id=${t.gameId} by=${t.did} seq=${t.seq}`);
  sonnetLog("DISCOVERY", `roster proposals observed: ${result.rosterProposals.length}`);
  for (const r of result.rosterProposals) sonnetLog("DISCOVERY", `  roster game_id=${r.gameId} members=${r.members.length} by=${r.did} seq=${r.seq}`);
  sonnetLog("DISCOVERY", `existing submissions: ${result.submissions.length}`);
  for (const s of result.submissions) sonnetLog("DISCOVERY", `  submission game_id=${s.gameId} by=${s.did} seq=${s.seq}`);
  if (result.malformedLines > 0) sonnetLog("DISCOVERY", `skipped ${result.malformedLines} malformed export line(s) across the scanned rooms`);
  for (const e of result.roomErrors) sonnetError("ERROR", `${e.room}: ${e.error}`);

  let state = loadState(config.statePath, contest.contest_id, agent.did);
  state.discovery = toDiscoverySnapshot(result);
  if (state.phase === "REGISTERED") state = transition(state, "DISCOVERING");
  saveState(config.statePath, state);
  sonnetLog("STATE", `discovery snapshot persisted to ${config.statePath}`);
}

async function cmdRegister(flags: Record<string, string | true>): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();

  const role = (typeof flags.role === "string" ? flags.role : "writer") as SonnetRole;
  const xAccountUrl = typeof flags["x-account"] === "string" ? flags["x-account"] : undefined;
  const requestId = typeof flags["request-id"] === "string" ? flags["request-id"] : undefined;
  const forceDryRun = flags["dry-run"] === true;

  const effectiveConfig = forceDryRun ? { ...config, dryRun: true } : config;

  if (forceDryRun) {
    const preview = buildRegistrationPreview(agent.identity, contest, effectiveConfig, { role, xAccountUrl, requestId });
    sonnetLog("REGISTER", "[DRY-RUN] would publish:");
    sonnetLog("REGISTER", `  room: ${preview.room}`);
    sonnetLog("REGISTER", `  payload (canonical): ${preview.canonicalJson}`);
    sonnetLog("REGISTER", `  did: ${preview.did}`);
    sonnetLog("REGISTER", `  local signature verification: ${preview.verifiedLocally ? "PASS" : "FAIL"}`);
    sonnetLog("REGISTER", "  sent: false (--dry-run)");
    return;
  }

  let state = loadState(config.statePath, contest.contest_id, agent.did);
  const result = await register(agent.identity, contest, effectiveConfig, { role, xAccountUrl, requestId }, state.registration);

  let changed = false;
  if (result.sent) {
    state.registration = { role, requestId: result.preview.payload.request_id, xAccountUrl, confirmedSeq: result.postedSeq };
    changed = true;
  }
  // Reconcile the phase whenever local state shows a registration, whether it
  // was just sent above or already existed (the idempotent no-op path, or a
  // registration recorded by a run before this transition logic existed) --
  // never gated on `result.sent` alone.
  if (state.registration && state.phase === "UNREGISTERED") {
    state = transition(state, "REGISTERED");
    changed = true;
  }
  if (changed) saveState(config.statePath, state);
}

async function cmdRecruit(flags: Record<string, string | true>): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();
  const forceDryRun = flags["dry-run"] === true;
  const effectiveConfig = forceDryRun ? { ...config, dryRun: true } : config;

  const wordCache = readJsonFile<DidWordCache>(config.wordCachePath);
  const wordCacheForMessage = wordCache && wordCache.did === agent.did ? wordCache : undefined;

  if (forceDryRun) {
    const preview = buildRecruitPreview(agent.identity, contest, effectiveConfig, { wordCache: wordCacheForMessage });
    sonnetLog("TEAM", "[DRY-RUN] would publish:");
    sonnetLog("TEAM", `  room: ${preview.room}`);
    sonnetLog("TEAM", `  text: ${JSON.stringify(preview.text)}`);
    sonnetLog("TEAM", `  local signature verification: ${preview.verifiedLocally ? "PASS" : "FAIL"}`);
    sonnetLog("TEAM", "  sent: false (--dry-run)");
    return;
  }

  let state = loadState(config.statePath, contest.contest_id, agent.did);
  const result = await recruit(agent.identity, contest, effectiveConfig, {
    wordCache: wordCacheForMessage,
    lastSentAtUtc: state.lastRecruitAtUtc,
    minIntervalMs: config.recruitMinIntervalMs,
  });
  if (result.sent) {
    state = { ...state, lastRecruitAtUtc: new Date().toISOString() };
    saveState(config.statePath, state);
  }
}

async function cmdJoin(flags: Record<string, string | true>): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();

  const gameId = typeof flags["game-id"] === "string" ? flags["game-id"] : undefined;
  if (!gameId || !GAME_ID_PATTERN.test(gameId)) throw new RecruitError(`--game-id is required and must match ${GAME_ID_PATTERN}`);
  const requesterDid = typeof flags["requester-did"] === "string" ? flags["requester-did"] : undefined;
  if (!requesterDid || !DID_PATTERN.test(requesterDid)) throw new RecruitError("--requester-did is required and must be a valid did:key");

  const forceDryRun = flags["dry-run"] === true;
  const effectiveConfig = forceDryRun ? { ...config, dryRun: true } : config;

  const wordCache = readJsonFile<DidWordCache>(config.wordCachePath);
  const wordCacheForMessage = wordCache && wordCache.did === agent.did ? wordCache : undefined;

  if (forceDryRun) {
    const preview = buildJoinInterestPreview(agent.identity, contest, effectiveConfig, gameId, requesterDid, { wordCache: wordCacheForMessage });
    sonnetLog("TEAM", "[DRY-RUN] would publish:");
    sonnetLog("TEAM", `  room: ${preview.room}`);
    sonnetLog("TEAM", `  text: ${JSON.stringify(preview.text)}`);
    sonnetLog("TEAM", `  local signature verification: ${preview.verifiedLocally ? "PASS" : "FAIL"}`);
    sonnetLog("TEAM", "  sent: false (--dry-run)");
    return;
  }

  let state = loadState(config.statePath, contest.contest_id, agent.did);
  const result = await joinTeamRequest(agent.identity, contest, effectiveConfig, gameId, requesterDid, {
    wordCache: wordCacheForMessage,
    lastSentAtUtc: state.lastRecruitAtUtc,
    minIntervalMs: config.recruitMinIntervalMs,
  });
  if (result.sent) {
    const sentAtUtc = new Date().toISOString();
    const existing = state.pendingJoinInterests ?? [];
    state = {
      ...state,
      lastRecruitAtUtc: sentAtUtc,
      pendingJoinInterests: [...existing.filter((i) => i.gameId !== gameId), { gameId, requesterDid, sentAtUtc }],
    };
    saveState(config.statePath, state);
  }
}

async function cmdTeam(flags: Record<string, string | true>): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();

  const gameId = typeof flags["game-id"] === "string" ? flags["game-id"] : undefined;
  if (!gameId || !GAME_ID_PATTERN.test(gameId)) {
    throw new TeamError(`--game-id is required and must match ${GAME_ID_PATTERN}`);
  }
  const forceDryRun = flags["dry-run"] === true;
  const effectiveConfig = forceDryRun ? { ...config, dryRun: true } : config;

  if (forceDryRun) {
    const preview = buildTeamRequestPreview(agent.identity, contest, effectiveConfig, gameId);
    sonnetLog("TEAM", "[DRY-RUN] would publish:");
    sonnetLog("TEAM", `  room: ${preview.room}`);
    sonnetLog("TEAM", `  payload (canonical): ${preview.canonicalJson}`);
    sonnetLog("TEAM", `  local signature verification: ${preview.verifiedLocally ? "PASS" : "FAIL"}`);
    sonnetLog("TEAM", "  sent: false (--dry-run)");
    return;
  }

  let state = loadState(config.statePath, contest.contest_id, agent.did);
  const alreadyRequested = state.team?.gameId === gameId;
  const result = await requestTeam(agent.identity, contest, effectiveConfig, gameId, {
    alreadyRequested,
    requestId: state.team?.requestId,
  });

  if (result.sent) {
    state = { ...state, team: { gameId, requestId: result.preview.payload.request_id, requestedAtUtc: new Date().toISOString() } };
    if (state.phase === "DISCOVERING") state = transition(state, "TEAM_REQUESTED");
    saveState(config.statePath, state);
  }

  sonnetLog("TEAM", `checking whether the referee has set up ${sonnetRooms(contest).team(gameId)}...`);
  const setup = await checkRoomSetup(contest, config, gameId);
  if (setup.hasMessages) {
    sonnetLog("TEAM", `room is set up: generation=${setup.generation} candidate referee=${setup.refereeCandidateDid ?? "(unknown)"}`);
    if (state.team && state.team.gameId === gameId) {
      state = { ...state, team: { ...state.team, room: setup.room, roomGeneration: setup.generation } };
      if (state.phase === "TEAM_REQUESTED") state = transition(state, "ROOM_ASSIGNED");
      saveState(config.statePath, state);
    }
  } else {
    sonnetLog("TEAM", "room not set up yet (no messages observed) -- re-run sonnet:team later to check again");
  }
}

async function cmdRoster(flags: Record<string, string | true>): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();

  const gameId = typeof flags["game-id"] === "string" ? flags["game-id"] : undefined;
  if (!gameId || !GAME_ID_PATTERN.test(gameId)) {
    throw new RosterError(`--game-id is required and must match ${GAME_ID_PATTERN}`);
  }
  const membersRaw = typeof flags.members === "string" ? flags.members : undefined;
  if (!membersRaw) throw new RosterError("--members is required (comma-separated DIDs, 4-8, this DID included)");
  const members = membersRaw.split(",").map((m) => m.trim()).filter((m) => m.length > 0);
  for (const m of members) {
    if (!DID_PATTERN.test(m)) throw new RosterError(`not a valid did:key: ${JSON.stringify(m)}`);
  }
  if (!members.includes(agent.did)) throw new RosterError("--members must include our own DID");

  const forceDryRun = flags["dry-run"] === true;
  const effectiveConfig = forceDryRun ? { ...config, dryRun: true } : config;

  const rooms = sonnetRooms(contest);
  const poemRoom = rooms.team(gameId);
  const roomGenerationFlag = typeof flags["room-generation"] === "string" ? Number.parseInt(flags["room-generation"], 10) : undefined;
  const setup = roomGenerationFlag === undefined ? await checkRoomSetup(contest, config, gameId) : undefined;
  const roomGeneration = roomGenerationFlag ?? setup?.generation;
  if (roomGeneration === undefined) {
    throw new RosterError(`could not determine room_generation for ${poemRoom} (referee hasn't set it up yet, or pass --room-generation explicitly)`);
  }

  sonnetLog("ROSTER", "scanning discovery room for existing roster proposals before signing...");
  const scanResult = await scanRooms(agent.did, contest, config);
  const conflict = detectRosterConflict(gameId, members, scanResult.rosterProposals);
  if (conflict) {
    sonnetLog("CONFLICT", `game_id=${gameId} has ${conflict.conflictingProposals.length} conflicting roster proposal(s) -- not signing`);
    for (const c of conflict.conflictingProposals) sonnetLog("CONFLICT", `  by=${c.did} members=[${c.members.join(", ")}]`);
    process.exitCode = 1;
    return;
  }
  const signers = summarizeRosterSigners(gameId, members, scanResult.rosterProposals);
  sonnetLog("ROSTER", `signers confirmed: ${signers.confirmedSigners.length}/${members.length} (${signers.confirmedSigners.join(", ") || "none yet"})`);
  sonnetLog("ROSTER", `signers pending: ${signers.pendingSigners.join(", ") || "none"}`);

  if (forceDryRun) {
    const preview = buildRosterPreview(agent.identity, contest, effectiveConfig, { gameId, poemRoom, roomGeneration, members });
    sonnetLog("ROSTER", "[DRY-RUN] would publish:");
    sonnetLog("ROSTER", `  room: ${preview.room}`);
    sonnetLog("ROSTER", `  payload (canonical): ${preview.canonicalJson}`);
    sonnetLog("ROSTER", `  local signature verification: ${preview.verifiedLocally ? "PASS" : "FAIL"}`);
    sonnetLog("ROSTER", "  sent: false (--dry-run)");
    return;
  }

  let state = loadState(config.statePath, contest.contest_id, agent.did);
  const result = await signRoster(agent.identity, contest, effectiveConfig, { gameId, poemRoom, roomGeneration, members }, scanResult.rosterProposals);
  if (result.sent) {
    state = { ...state, roster: { members, requestId: result.preview.payload.request_id, signedAtUtc: new Date().toISOString() } };
    if (state.phase === "ROOM_ASSIGNED") state = transition(state, "ROSTER_PENDING");
    saveState(config.statePath, state);
  }
}

async function cmdRun(): Promise<void> {
  const config = loadSonnetConfig();
  const contest = loadContestConfig(config);
  const agent = loadSonnetIdentity();

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    sonnetLog("POLL", `received ${signal} -- will stop after the current tick`);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  await runLoop(agent, contest, config, config.statePath, loadState, { shouldStop: () => stopping });
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const { flags } = parseFlags(rest);

  switch (command) {
    case "preflight":
      return cmdPreflight();
    case "scan":
      return cmdScan();
    case "register":
      return cmdRegister(flags);
    case "recruit":
      return cmdRecruit(flags);
    case "join":
      return cmdJoin(flags);
    case "team":
      return cmdTeam(flags);
    case "roster":
      return cmdRoster(flags);
    case "run":
      return cmdRun();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (
    err instanceof IdentityError ||
    err instanceof TechnocoreError ||
    err instanceof SonnetConfigError ||
    err instanceof SonnetIdentityError ||
    err instanceof CmudictError ||
    err instanceof RegistrationError ||
    err instanceof RecruitError ||
    err instanceof TeamError ||
    err instanceof RosterError
  ) {
    sonnetError("ERROR", err.message);
  } else {
    sonnetError("ERROR", err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
