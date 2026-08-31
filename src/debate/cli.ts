#!/usr/bin/env node
/**
 * `npm run debate` -- the long-running service. One process, one event loop, no
 * cron: initialize once, then loop forever with a proper async sleep between
 * turns until SIGTERM/SIGINT.
 */

import { initializeRuntime, setupRoom } from "./runtime.js";
import { runDebateLoop } from "./loop.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine, config.ts falls back to defaults / process.env as-is.
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

  await setupRoom(runtime);

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

  await runDebateLoop(runtime, { signal: controller.signal });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
