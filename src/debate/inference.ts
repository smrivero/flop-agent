/**
 * The debate orchestrator (loop.ts) depends on this interface, never on the
 * OpenAI SDK directly -- so a future FLOP inference provider can be added by
 * implementing InferenceProvider and switching INFERENCE_PROVIDER, without
 * touching Technocore, DID handling, turn scheduling, claim state, the
 * quality gate, personalities, or room logic at all.
 *
 * Only OpenAIInferenceProvider exists today -- it's a thin wrapper around the
 * already-working, already-tested generateDebateTurn (openai.ts), not a
 * rewrite. No FLOP provider is implemented here: there is no public FLOP
 * inference API/testnet to build one against yet, and inventing one would
 * just be a lie this file tells the type checker. When one exists, it's a new
 * class in this file plus a new case in runtime.ts's provider switch --
 * everything downstream of InferenceProvider is already decoupled.
 */

import type OpenAI from "openai";
import { generateDebateTurn, type GenerateTurnParams, type GenerateTurnResult } from "./openai.js";
import type { DebateConfig } from "./types.js";

export type GenerateTurnInput = GenerateTurnParams;
export type GenerateTurnOutput = GenerateTurnResult;

export interface InferenceProvider {
  generateTurn(input: GenerateTurnInput): Promise<GenerateTurnOutput>;
}

export class OpenAIInferenceProvider implements InferenceProvider {
  constructor(
    private readonly client: OpenAI,
    private readonly config: DebateConfig,
  ) {}

  generateTurn(input: GenerateTurnInput): Promise<GenerateTurnOutput> {
    return generateDebateTurn(this.client, this.config, input);
  }
}

/** Builds the configured provider. Throws (config.ts already validates this
 * earlier, so in practice this branch is unreachable in normal use) rather
 * than silently falling back to OpenAI if INFERENCE_PROVIDER is ever
 * something this build doesn't know how to construct. */
export function createInferenceProvider(client: OpenAI, config: DebateConfig): InferenceProvider {
  if (config.inferenceProvider === "openai") return new OpenAIInferenceProvider(client, config);
  throw new Error(`Unknown INFERENCE_PROVIDER: ${JSON.stringify(config.inferenceProvider)}`);
}
