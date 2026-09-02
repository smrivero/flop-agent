/**
 * Safe, limited job executor. An accepted contract's `job.proto` is chosen by
 * the COUNTERPARTY (untrusted room content) -- this module never executes
 * arbitrary code or commands found in a room. Only job types in the
 * `TCLK_MKT_SUPPORTED_JOB_TYPES` whitelist run at all; the state machine
 * (dealManager.ts) only ever calls this once a contract has reached `locked`
 * for a job type that already passed the policy engine at accept time, and
 * this module independently re-checks the whitelist itself (defense in depth
 * -- config can change between accept and work in a long-lived process).
 *
 * `job.id` / `job.context` are untrusted strings from the room: they are only
 * ever echoed back verbatim into this worker's OWN result text, never passed
 * to a shell, `eval`, `fetch`, or any other interpreter.
 */

export class UnsupportedJobError extends Error {}

export interface JobExecutionInput {
  proto: string;
  id: string;
  context?: string;
  contractId: string;
}

export interface JobExecutionResult {
  ok: boolean;
  summary: string;
}

/** `echo`: the trivial, fully side-effect-free job -- proves the whole
 * accept -> lock -> work -> reveal choreography without doing anything a
 * hostile offer could weaponize. */
function runEcho(input: JobExecutionInput): JobExecutionResult {
  return { ok: true, summary: `echo job ${input.id} completed for contract ${input.contractId}` };
}

/** `research-test` / `verification-test`: placeholder job types for this first
 * version -- the tclk/1 job vocabulary (SPEC.md §6) does not itself define a
 * concrete "do X" payload beyond `{proto, id, context?}`, so there is nothing
 * here to interpret as an action; a real implementation of either would plug
 * in here later (e.g. reusing mentions/verifier's own independent-fetch +
 * OpenAI pipeline) behind the SAME whitelist gate. For now this just proves
 * the job was accepted and reached the work step -- never executes anything
 * external. */
function runStubJob(kind: string, input: JobExecutionInput): JobExecutionResult {
  return { ok: true, summary: `${kind} job ${input.id} accepted and marked complete (stub executor, no external work performed)` };
}

export function executeJob(input: JobExecutionInput, supportedJobTypes: string[]): JobExecutionResult {
  if (!supportedJobTypes.includes(input.proto)) {
    throw new UnsupportedJobError(`job proto ${JSON.stringify(input.proto)} is not in TCLK_MKT_SUPPORTED_JOB_TYPES`);
  }
  switch (input.proto) {
    case "echo":
      return runEcho(input);
    case "research-test":
    case "verification-test":
      return runStubJob(input.proto, input);
    default:
      // Whitelisted by config but no handler wired up -- fail closed rather
      // than silently doing nothing and revealing anyway.
      throw new UnsupportedJobError(`job proto ${JSON.stringify(input.proto)} is whitelisted but has no executor implementation`);
  }
}
