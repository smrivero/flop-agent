#!/usr/bin/env node
/** `npm run status` -- read-only snapshot. Never prints secrets: no API key, no
 * private key/seed material, only public DIDs and configuration. */

import { initializeRuntime } from "./runtime.js";
import { determineNextSpeaker, readDebateHistory } from "./history.js";
import { loadState } from "./state.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file -- fine.
}

async function main(): Promise<void> {
  const runtime = initializeRuntime();
  const snapshot = await readDebateHistory(runtime.client, runtime.definition.room, runtime.agentA.did, runtime.agentB.did);
  const nextSpeakerId = determineNextSpeaker(snapshot.turns);
  const nextSpeaker = nextSpeakerId === "A" ? runtime.agentA : runtime.agentB;
  const lastTurn = snapshot.turns[snapshot.turns.length - 1];
  const state = loadState(runtime.config.statePath, runtime.definition.room);

  const lines = [
    `room: ${runtime.definition.room}`,
    `topic: ${runtime.definition.topic}`,
    `agent A (${runtime.agentA.name}): ${runtime.agentA.did}`,
    `agent B (${runtime.agentB.name}): ${runtime.agentB.did}`,
    `last technocore seq: ${snapshot.lastSeq}`,
    `last speaker: ${lastTurn ? (lastTurn.agentId === "A" ? runtime.agentA.name : runtime.agentB.name) : "(none yet -- debate hasn't started)"}`,
    `next speaker: ${nextSpeaker.name}`,
    `messages generated (local count): ${state.totalMessages}`,
    `min/max interval: ${runtime.config.minDelaySeconds}-${runtime.config.maxDelaySeconds} seconds`,
    `history window: last ${runtime.config.historyMessages} messages`,
    `max message length: ${runtime.config.maxMessageChars} characters`,
    `web search: ${runtime.config.webSearchEnabled ? "enabled" : "disabled"}`,
    `model: ${runtime.config.openAiModel}`,
    `technocore base url: ${runtime.config.technocoreBaseUrl}`,
  ];
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
