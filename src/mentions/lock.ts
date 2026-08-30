/**
 * Single-instance guard for cron. If a run is still going (or hung) when the next
 * cron tick fires, the new process must exit immediately rather than run
 * concurrently against the same SQLite file and Technocore identity.
 *
 * A plain lock file, not SQLite-level locking: it has to work before the database
 * is even opened, and a PID is trivial to check for staleness (a hung/killed
 * process leaves a lock file behind forever otherwise).
 */

import { closeSync, constants, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export class LockHeldError extends Error {}

interface LockFileContents {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, just not ours
  }
}

/**
 * Acquire the lock or throw LockHeldError. Returns a release function; call it
 * (ideally in a `finally`) when the run finishes.
 */
export function acquireLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });

  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const contents: LockFileContents = { pid: process.pid, startedAt: new Date().toISOString() };
    writeSync(fd, JSON.stringify(contents));
    closeSync(fd);
    return () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone -- nothing left to release.
      }
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Lock file exists -- decide whether it's real or abandoned by a dead/killed run.
  let existing: LockFileContents | undefined;
  try {
    existing = JSON.parse(readFileSync(lockPath, "utf8")) as LockFileContents;
  } catch {
    existing = undefined; // corrupt lock file -- treat as stale below
  }

  const stale = existing === undefined || !isProcessAlive(existing.pid);
  if (!stale) {
    throw new LockHeldError(
      `another execution is active (pid ${existing!.pid}, started ${existing!.startedAt})`,
    );
  }

  try {
    unlinkSync(lockPath);
  } catch {
    // Race with whoever else is cleaning it up -- fall through and retry once.
  }
  return acquireLock(lockPath);
}
