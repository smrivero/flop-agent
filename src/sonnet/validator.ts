/**
 * Two independent validators, deliberately never merged (per the operator's
 * own instruction: "Separar: MechanicalValidator / PoetryScorer"):
 *
 * 1. `validateWordProposal` -- MECHANICAL, fail-closed, hard eligibility
 *    rules for ONE word proposal (roster/turn/dictionary/DID/syllable/state/
 *    contest-window checks). No literary judgment anywhere in this function.
 *    A candidate poetry-planner.ts (not yet implemented) picks must still
 *    pass this before it is ever proposed -- see cli.ts's future write path.
 *
 * 2. `runOfficialValidator` -- shells out to the FROZEN, unmodified official
 *    script (`vendor/technocore-sonnet/sonnet_validate.py`) for the final
 *    whole-poem format check before submission, exactly as instructed
 *    ("no crear una validación distinta si podemos reutilizar el script
 *    oficial"). This is the authoritative mechanical gate for a complete
 *    poem; nothing here reimplements `validate_poem`.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validateWordForDid, DidWordError } from "./did-words.js";
import type { Lexicon } from "./cmudict.js";
import type { ContestConfig, SonnetConfig } from "./config.js";

const execFileAsync = promisify(execFile);

// -- mechanical per-word validation ------------------------------------------

/** The subset of authoritative poem state one word proposal needs to be
 * checked against -- a local shape, not yet wired to state.ts's `poem` field
 * (room-poller.ts, which derives this from the team room, is not yet
 * implemented; see README "Sonnet Challenge" status). */
export interface PoemTurnState {
  version: number;
  previousStateHash: string;
  /** Syllables already used in the line currently being written. */
  currentLineSyllables: number;
  previousContributorDid?: string;
}

export interface ValidateProposalInput {
  word: string;
  contributorDid: string;
  lexicon: Lexicon;
  rosterMembers: readonly string[];
  rosterLocked: boolean;
  poemState: PoemTurnState;
  contestOpeningUtc: string;
  contestDeadlineUtc: string;
  /** Only checked when both are supplied -- lets a caller re-validate a
   * built proposal against the state it actually quotes, right before POST,
   * catching drift between "when we built it" and "when we're about to send
   * it" (see sonnet-game.md "avoid publishing against stale state"). */
  expectedVersion?: number;
  expectedPreviousStateHash?: string;
  now?: Date;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  syllables?: number;
}

/**
 * Fail-closed: returns `valid: true` only when EVERY applicable hard rule
 * passes. Never partially trusts a candidate -- this is the last mechanical
 * gate before a word proposal is signed (see README "WORD PROPOSAL ENGINE"
 * pipeline: MECHANICAL CONSTRAINTS -> ... -> LOCAL VALIDATION -> POST).
 */
export function validateWordProposal(input: ValidateProposalInput): ValidationResult {
  const errors: string[] = [];
  const now = input.now ?? new Date();

  if (!input.rosterLocked) errors.push("roster is not locked -- no word may be proposed yet");
  if (!input.rosterMembers.includes(input.contributorDid)) errors.push("contributor is not a member of the locked roster");
  if (input.poemState.previousContributorDid === input.contributorDid) {
    errors.push("contributor was the previous accepted contributor -- may not propose the next word");
  }

  const openingMs = Date.parse(input.contestOpeningUtc);
  const deadlineMs = Date.parse(input.contestDeadlineUtc);
  if (now.getTime() < openingMs) errors.push("contest has not opened yet");
  if (now.getTime() > deadlineMs) errors.push("contest deadline has passed");

  let syllables: number | undefined;
  try {
    syllables = validateWordForDid(input.word, input.contributorDid, input.lexicon);
  } catch (err) {
    errors.push(err instanceof DidWordError ? err.message : String(err));
  }
  if (syllables !== undefined && input.poemState.currentLineSyllables + syllables > 10) {
    errors.push(`word would overflow the line: ${input.poemState.currentLineSyllables} + ${syllables} > 10`);
  }

  if (input.expectedVersion !== undefined && input.expectedVersion !== input.poemState.version) {
    errors.push(`stale version: expected ${input.expectedVersion}, authoritative state is now ${input.poemState.version}`);
  }
  if (input.expectedPreviousStateHash !== undefined && input.expectedPreviousStateHash !== input.poemState.previousStateHash) {
    errors.push("stale previous_state_hash -- authoritative state has moved on");
  }

  return { valid: errors.length === 0, errors, syllables };
}

// -- official whole-poem validator (subprocess) ------------------------------

export class OfficialValidatorError extends Error {}

export interface OfficialValidationOutput {
  form_valid: true;
  syllables_per_line: number[];
  dictionary_sha256: string;
}

export interface OfficialValidationResult {
  ok: boolean;
  output?: OfficialValidationOutput;
  /** Raw stderr from the official script when ok is false -- the script's
   * own error messages, not reworded. */
  error?: string;
}

/**
 * Runs the vendored, unmodified `sonnet_validate.py` against `poemText`
 * (already built as the exact canonical text: one ASCII space between
 * words, LF between lines, one blank line between stanzas, no terminal
 * newline -- see sonnet-game.md "Publication and submission"). Requires a
 * `python3` on PATH; throws OfficialValidatorError if it can't be invoked at
 * all (missing interpreter, vendored script missing) -- distinct from
 * `ok: false`, which means the script ran and reported the poem invalid.
 */
export async function runOfficialValidator(config: SonnetConfig, poemText: string): Promise<OfficialValidationResult> {
  const scriptPath = join(config.vendorRoot, "sonnet_validate.py");
  const dictPath = join(config.vendorRoot, "cmudict.dict");

  const dir = await mkdtemp(join(tmpdir(), "sonnet-validate-"));
  const poemPath = join(dir, "poem.txt");
  try {
    await writeFile(poemPath, poemText, "utf8");
    const { stdout } = await execFileAsync("python3", [scriptPath, dictPath, poemPath, "--exact-ten"]);
    const output = JSON.parse(stdout) as OfficialValidationOutput;
    return { ok: true, output };
  } catch (err) {
    const asExecError = err as { code?: number; stderr?: string; message?: string };
    if (asExecError.stderr !== undefined) {
      // The script itself ran and exited non-zero (form rejected) -- its
      // stderr line is the authoritative reason, passed through unchanged.
      return { ok: false, error: asExecError.stderr.trim() };
    }
    throw new OfficialValidatorError(`could not run the official validator: ${asExecError.message ?? String(err)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
