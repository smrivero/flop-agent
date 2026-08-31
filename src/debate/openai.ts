/**
 * One OpenAI Responses API call per turn, with the hosted web_search tool.
 *
 * Confirmed against the current docs (developers.openai.com/api/docs/guides/
 * tools-web-search, fetched while building this) that the current tool type is
 * exactly `{ type: "web_search" }` -- the installed SDK's bundled TypeScript
 * types (openai@4.104.0) still only list `web_search_preview` variants, so the
 * one field below needs a deliberate type escape; the runtime API accepts the
 * plain JSON either way, since it's not validated against the SDK's local types.
 *
 * Retry/backoff for 429 and 5xx, and the request timeout, are both delegated to
 * the official SDK's own `maxRetries` / `timeout` client options rather than
 * hand-rolled here -- it already implements exponential backoff with
 * Retry-After awareness, and re-solving that ourselves would just be a worse
 * copy of it.
 */

import OpenAI from "openai";
import type { DebateConfig } from "./types.js";

export function createOpenAiClient(config: DebateConfig): OpenAI {
  return new OpenAI({
    apiKey: config.openAiApiKey,
    timeout: config.httpTimeoutMs,
    maxRetries: config.maxRetries,
  });
}

export interface GenerateTurnParams {
  instructions: string;
  input: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerateTurnResult {
  text: string;
  usage?: TokenUsage;
}

export async function generateDebateTurn(
  client: OpenAI,
  config: DebateConfig,
  params: GenerateTurnParams,
): Promise<GenerateTurnResult> {
  const response = await client.responses.create({
    model: config.openAiModel,
    instructions: params.instructions,
    input: params.input,
    max_output_tokens: config.openAiMaxOutputTokens,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see file header
    tools: config.webSearchEnabled ? ([{ type: "web_search" }] as any) : undefined,
  });

  const text = response.output_text?.trim() ?? "";
  if (!text) {
    throw new Error("OpenAI response had no output text (model may have only returned tool calls)");
  }

  const usage: TokenUsage | undefined = response.usage
    ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return { text, usage };
}
