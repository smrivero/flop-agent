/**
 * Wires config + identities + clients together. Separate from loop.ts so
 * `debate:setup` and `status` can build a Runtime and stop there, without
 * pulling in the continuous-loop machinery they don't need.
 */

import OpenAI from "openai";
import { fetchWithTimeout } from "../mentions/http.js";
import { TechnocoreClient } from "../technocore.js";
import { loadDebateConfig, loadDebateDefinition, loadPersonality } from "./config.js";
import { buildLoadedAgent, loadOrCreateIdentity } from "./identity.js";
import { createInferenceProvider, type InferenceProvider } from "./inference.js";
import { createOpenAiClient } from "./openai.js";
import { ensureRoomOwnership, RoomOwnershipConflictError } from "./ownership.js";
import type { DebateConfig, DebateDefinition, LoadedAgent } from "./types.js";

export interface Runtime {
  config: DebateConfig;
  definition: DebateDefinition;
  agentA: LoadedAgent;
  agentB: LoadedAgent;
  agentACreated: boolean;
  agentBCreated: boolean;
  client: TechnocoreClient;
  openai: OpenAI;
  /** What loop.ts actually calls to generate a turn -- see inference.ts. Never
   * the OpenAI SDK directly; this is the FLOP-readiness extension point. */
  inferenceProvider: InferenceProvider;
}

/**
 * Builds the full runtime from .env + config/debate.yaml + the two identity
 * files (loading each if present, generating -- never regenerating -- if
 * absent). Performs no network I/O itself.
 */
export function initializeRuntime(): Runtime {
  const config = loadDebateConfig();
  const definition = loadDebateDefinition(config.debateConfigPath);

  const { identity: identityA, created: agentACreated } = loadOrCreateIdentity(config.agentAIdentityPath);
  const { identity: identityB, created: agentBCreated } = loadOrCreateIdentity(config.agentBIdentityPath);

  const personalityA = loadPersonality(definition.agentA.personalityFile);
  const personalityB = loadPersonality(definition.agentB.personalityFile);

  const agentA = buildLoadedAgent(
    "A",
    identityA,
    definition.agentA.name,
    definition.agentA.position,
    definition.agentB.name,
    definition.agentB.position,
    personalityA,
  );
  const agentB = buildLoadedAgent(
    "B",
    identityB,
    definition.agentB.name,
    definition.agentB.position,
    definition.agentA.name,
    definition.agentA.position,
    personalityB,
  );

  // Timeout only, deliberately no automatic retry on writes: a signed write's
  // canonical string embeds its nonce, so retrying an identical request after a
  // client-side timeout (even though the server may have already accepted it)
  // would resend the same nonce and get refused as replay -- a real success
  // misreported as a failure. Same reasoning, same fix, as the mentions
  // pipeline's publisher (src/mentions/publisher/publishMention.ts).
  const client = new TechnocoreClient({
    baseUrl: config.technocoreBaseUrl,
    fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs),
  });

  const openai = createOpenAiClient(config);
  const inferenceProvider = createInferenceProvider(openai, config);

  return { config, definition, agentA, agentB, agentACreated, agentBCreated, client, openai, inferenceProvider };
}

export interface SetupResult {
  ownership?: { claimed: boolean; allowListUpdated: boolean };
  topicSet: boolean;
}

/**
 * Idempotent: claims the room for Agent A and allow-lists Agent B if `room`
 * starts with `d-`; sets the topic note either way. Safe to call on every
 * startup and from the standalone `debate:setup` command.
 */
export async function setupRoom(runtime: Runtime): Promise<SetupResult> {
  const { client, agentA, agentB, definition, config } = runtime;
  const result: SetupResult = { topicSet: false };

  if (definition.room.startsWith("d-")) {
    try {
      const ownership = await ensureRoomOwnership(client, agentA, agentB, definition.room, config.technocoreBaseUrl);
      result.ownership = ownership;
    } catch (err) {
      if (err instanceof RoomOwnershipConflictError) throw err; // fail clearly, do not continue
      throw err;
    }
  }

  try {
    await client.writeNote("topic", definition.room, definition.topic);
    result.topicSet = true;
  } catch {
    // Non-critical: /rooms just won't show a topic for this room. Never block
    // startup on a cosmetic note write.
  }

  return result;
}
