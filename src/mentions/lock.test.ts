import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError } from "./lock.js";

function tempLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "flop-agent-lock-test-"));
  return join(dir, "mentions.lock");
}

test("lock: a second acquire fails while the first is held", () => {
  const path = tempLockPath();
  const release = acquireLock(path);
  assert.throws(() => acquireLock(path), LockHeldError);
  release();
});

test("lock: releasing lets a subsequent acquire succeed", () => {
  const path = tempLockPath();
  const release = acquireLock(path);
  release();
  const release2 = acquireLock(path);
  release2();
});

test("lock: a stale lock (dead pid) is recovered automatically", () => {
  const path = tempLockPath();
  // A pid essentially guaranteed not to be running (max valid pid + 1 on Linux/macOS).
  writeFileSync(path, JSON.stringify({ pid: 4194304, startedAt: new Date().toISOString() }));
  const release = acquireLock(path); // should not throw
  release();
});

test("lock: a corrupt lock file is treated as stale, not as a crash", () => {
  const path = tempLockPath();
  writeFileSync(path, "not json");
  const release = acquireLock(path);
  release();
});
