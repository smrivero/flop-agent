/**
 * Atomic local JSON persistence for sonnet/ state: write to a sibling temp
 * file, fsync it, then rename over the target -- rename is atomic on the same
 * filesystem (POSIX and NTFS both), so a crash mid-write never leaves a
 * corrupt/partial state.json behind; readers always see either the old file
 * or the fully-written new one, never a half-written one.
 *
 * Never persists private key material -- callers only ever pass plain state
 * objects (DIDs, seq numbers, receipts, cached word lists), never an
 * identity's seed. See state.ts's SonnetState type for what actually gets
 * written to disk.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class PersistenceError extends Error {}

export function readJsonFile<T>(path: string): T | undefined {
  const resolved = resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new PersistenceError(`${resolved} exists but is not valid JSON: ${(err as Error).message}`);
  }
}

/** Writes `value` as pretty JSON to `path`, atomically (temp file + fsync +
 * rename). Creates parent directories as needed. */
export function writeJsonFileAtomic(path: string, value: unknown): void {
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });

  const tmpPath = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, resolved);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort cleanup only -- the rename error is the one that matters.
    }
    throw err;
  }
}
