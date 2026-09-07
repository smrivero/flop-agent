/**
 * cli.ts reuses mentions/lock.ts's acquireLock unchanged (see cli.ts's
 * cmdWatch/cmdBaseline) as its cron concurrency guard -- this just confirms
 * that reuse actually holds for a second overlapping invocation, the same
 * property mentions/lock.test.ts already proves for the mentions pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockHeldError } from "../mentions/lock.js";

test("concurrency: a second protocol-watcher run while one is active exits immediately via LockHeldError", () => {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-lock-"));
  const lockPath = join(dir, "protocol-watcher.lock");
  try {
    const release = acquireLock(lockPath);
    assert.throws(() => acquireLock(lockPath), LockHeldError);
    release();
    // Once released, a new run can acquire it again without issue.
    const release2 = acquireLock(lockPath);
    release2();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
