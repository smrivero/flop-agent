#!/usr/bin/env node
/**
 * `npm run debate` -- the long-running service. One process, one event loop, no
 * cron: initialize once, then loop forever with a proper async sleep between
 * turns until SIGTERM/SIGINT.
 */

import { initializeRuntime, setupRoom } from "./runtime.js";
import { runDebateLoop, sleep } from "./loop.js";
import { RoomOwnershipConflictError } from "./ownership.js";
import type { Runtime } from "./runtime.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config.ts falls back to defaults / process.env as-is.
}

const SETUP_RETRY_BASE_MS = 5_000;
const SETUP_RETRY_MAX_MS = 300_000; // 5 minutes

/**
 * setupRoom() is idempotent (ownership.ts checks current state before acting),
 * so retrying the whole thing from scratch on a transient failure -- a 503, a
 * timeout, a network blip -- is simple and safe: whatever already succeeded is
 * just detected as "already done" on the next attempt. A real conflict
 * (RoomOwnershipConflictError) is NOT retried -- that needs a human, not time.
 */
async function setupRoomWithRetry(runtime: Runtime, signal: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await setupRoom(runtime);
      return;
    } catch (err) {
      if (err instanceof RoomOwnershipConflictError) throw err;
      const delay = Math.min(SETUP_RETRY_BASE_MS * 2 ** attempt, SETUP_RETRY_MAX_MS);
      attempt++;
      console.log(`[setup] failed (${(err as Error).message ?? err}) -- retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay, signal);
    }
  }
}

async function main(): Promise<void> {
  console.log("[startup] autonomous debate service");

  const runtime = initializeRuntime();
  console.log(`[room] ${runtime.definition.room}`);
  console.log(`[topic] ${runtime.definition.topic}`);
  console.log(`[agent-a] ${runtime.agentA.did}`);
  console.log(`[agent-b] ${runtime.agentB.did}`);
  if (runtime.agentACreated) console.log("[agent-a] no identity file existed -- generated a new one");
  if (runtime.agentBCreated) console.log("[agent-b] no identity file existed -- generated a new one");

  const controller = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // a second signal shouldn't double-log or hang
    shuttingDown = true;
    console.log(`[shutdown] received ${signal} -- finishing the current turn if one is in flight, then stopping`);
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await setupRoomWithRetry(runtime, controller.signal);
  if (controller.signal.aborted) return; // stopped during setup retries, don't start the loop

  await runDebateLoop(runtime, { signal: controller.signal });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
