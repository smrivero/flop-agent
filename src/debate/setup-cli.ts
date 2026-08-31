#!/usr/bin/env node
/**
 * `npm run debate:setup` -- idempotent room-ownership setup only, no loop.
 * Safe to run repeatedly (e.g. before every `debate:` start) or on its own
 * after changing config/debate.yaml's `room`.
 */

import { initializeRuntime, setupRoom } from "./runtime.js";
import { RoomOwnershipConflictError } from "./ownership.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine.
}

async function main(): Promise<void> {
  const runtime = initializeRuntime();
  console.log(`[setup] room: ${runtime.definition.room}`);
  console.log(`[setup] agent-a did: ${runtime.agentA.did}${runtime.agentACreated ? " (newly generated)" : ""}`);
  console.log(`[setup] agent-b did: ${runtime.agentB.did}${runtime.agentBCreated ? " (newly generated)" : ""}`);

  const result = await setupRoom(runtime);

  if (result.ownership) {
    console.log(
      `[setup] ownership: ${result.ownership.claimed ? "claimed just now" : "already owned by Agent A"}`,
    );
    console.log(
      `[setup] allow-list: ${result.ownership.allowListUpdated ? "Agent B added" : "Agent B already allowed"}`,
    );
  } else {
    console.log(`[setup] room "${runtime.definition.room}" does not start with "d-" -- no ownership setup needed, it's an open room`);
  }
  console.log(`[setup] topic note ${result.topicSet ? "set" : "could not be set (non-critical)"}`);
  console.log("[setup] done");
}

main().catch((err) => {
  if (err instanceof RoomOwnershipConflictError) {
    console.error(`[setup] ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
