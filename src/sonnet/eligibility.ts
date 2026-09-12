/**
 * Best-effort, LOCAL check for pre-cutoff signed evidence of our own DID in
 * Technocore's public rooms -- see sonnet-game.md "Teams and identity":
 * "the referee must verify a message signed by the same Ed25519 DID in
 * trusted Technocore archive records with a server receipt timestamp
 * strictly before S." The same rule applies to both writer and voter
 * registration (sonnet-game.md repeats it verbatim for both), so one check
 * covers both roles.
 *
 * This is NOT the referee's own determination -- only the referee's accepted
 * registration receipt is authoritative (sonnet-game.md: "The referee keeps
 * the verified evidence and eligibility decisions in the archive"). This
 * module exists so `sonnet:preflight` can warn *before* spending a
 * registration attempt, not to substitute for the referee's check.
 *
 * There is no signer-indexed query on Technocore (confirmed against
 * ../technocore.ts's full endpoint surface: readRoom / discoverRooms /
 * listRooms / exportRoom -- none accept a signer filter), so this only
 * inspects a small, explicit list of rooms this project's own identity is
 * actually known to have posted in, plus any operator-configured extras
 * (SONNET_ELIGIBILITY_EXTRA_ROOMS). It never crawls or enumerates rooms it
 * wasn't told about, to avoid generating unnecessary traffic. NEVER reports
 * "eligible" without a concrete (room, seq, ts) piece of evidence -- absence
 * of evidence is always reported as "unknown", never as "not eligible" (we
 * cannot prove a negative, and older evidence may simply have rotated out of
 * a room's retained ring -- see the `limitations` this returns).
 */

import { TechnocoreClient } from "../technocore.js";
import { createTechnocoreClient } from "./http-debug.js";
import { readFullRoom } from "./room-export.js";
import type { ContestConfig, SonnetConfig } from "./config.js";

export type EligibilityStatus = "eligible" | "unknown";

export interface EligibilityEvidence {
  room: string;
  seq: number;
  ts: string;
}

export interface EligibilityCheckResult {
  status: EligibilityStatus;
  cutoffUtc: string;
  checkedRooms: string[];
  evidence?: EligibilityEvidence;
  limitations: string[];
}

/** Rooms this project's own identity is actually known to post signed
 * messages in -- see .env.example TECHNOCORE_ROOM (Radar's findings room)
 * and the tclk/ pair (config.ts confirms it reuses the same TECHNOCORE_ROOM,
 * not a separate one). Read from process.env directly here (not threaded
 * through SonnetConfig) so this module never has to guess a second room-name
 * convention -- it defers entirely to the existing TECHNOCORE_ROOM env var. */
function knownActivityRooms(env: NodeJS.ProcessEnv): string[] {
  const room = env.TECHNOCORE_ROOM?.trim();
  return room ? [room] : ["d-technocore-radar"];
}

export async function checkEligibility(
  did: string,
  contest: ContestConfig,
  config: SonnetConfig,
  options: { client?: TechnocoreClient; env?: NodeJS.ProcessEnv } = {},
): Promise<EligibilityCheckResult> {
  const env = options.env ?? process.env;
  const client = options.client ?? createTechnocoreClient(config);

  const cutoffMs = Date.parse(contest.identity_cutoff);
  if (!Number.isFinite(cutoffMs)) {
    throw new RangeError(`contest.json identity_cutoff is not a valid timestamp: ${JSON.stringify(contest.identity_cutoff)}`);
  }

  const candidateRooms = [...new Set([...knownActivityRooms(env), ...config.eligibilityExtraRooms])];
  const limitations: string[] = [
    "No signer-indexed query exists on Technocore -- this only checks the specific rooms listed in checkedRooms, never a crawl of all rooms.",
    "Each room read is its current retained ring (GET /r/<room>/export); a room's history rotates, so older evidence than the ring still holds is invisible to this check even if it once existed.",
    "This is a local self-check, not the referee's determination -- only an accepted registration receipt in the registration room is authoritative.",
  ];

  const checkedRooms: string[] = [];
  let evidence: EligibilityEvidence | undefined;

  for (const room of candidateRooms) {
    checkedRooms.push(room);
    try {
      const { messages, malformedLines } = await readFullRoom(client, room);
      if (malformedLines > 0) limitations.push(`${room}: ${malformedLines} export line(s) could not be parsed and were skipped.`);
      for (const message of messages) {
        if (message.from !== did) continue;
        const ts = Date.parse(message.ts);
        if (Number.isFinite(ts) && ts < cutoffMs) {
          evidence = { room, seq: message.seq, ts: message.ts };
          break;
        }
      }
    } catch (err) {
      limitations.push(`${room}: could not be read (${(err as Error).message})`);
    }
    if (evidence) break;
  }

  return {
    status: evidence ? "eligible" : "unknown",
    cutoffUtc: contest.identity_cutoff,
    checkedRooms,
    evidence,
    limitations,
  };
}
