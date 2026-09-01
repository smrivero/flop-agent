/**
 * One OpenAI Responses API call per turn, with the hosted web_search tool
 * forced (not optional) so factual claims are actually grounded, not just
 * "the tool was available."
 *
 * Confirmed against the current docs (developers.openai.com/api/docs/guides/
 * tools-web-search, fetched while building this) for three things the
 * installed SDK's bundled types (openai@4.104.0) don't yet know about --
 * they lag the API, the API itself accepts plain JSON regardless of what the
 * local .d.ts files declare:
 *   1. The tool type is `{ type: "web_search" }` (not the older
 *      `web_search_preview` the SDK's `Tool` union still lists).
 *   2. `tool_choice: "required"` is documented and valid; the docs recommend
 *      exactly this ("Use tool_choice: 'required' ... when search must run").
 *   3. A `web_search_call` output item has an `action: { type, query }` field
 *      (the SDK's `ResponseFunctionWebSearch` interface doesn't declare it at
 *      all), and `action.sources` (a URL list) appears when the request sets
 *      `include: ["web_search_call.action.sources"]` -- also not in the
 *      SDK's `ResponseIncludable` union yet.
 * All three need a deliberate, commented type escape below; none of it
 * affects what's actually sent/read over the wire.
 *
 * Retry/backoff for 429 and 5xx, and the request timeout, are both delegated
 * to the official SDK's own `maxRetries` / `timeout` client options.
 */

import OpenAI from "openai";
import type { DebateConfig } from "./types.js";

export class WebSearchNotPerformedError extends Error {}

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

export interface WebSearchInfo {
  called: boolean;
  queries: string[];
  sources: string[];
}

export interface GenerateTurnResult {
  text: string;
  usage?: TokenUsage;
  webSearch: WebSearchInfo;
}

interface RawWebSearchCallItem {
  type: "web_search_call";
  action?: { type?: string; query?: string; sources?: string[] };
}

function extractWebSearchInfo(output: unknown[]): WebSearchInfo {
  const calls = output.filter(
    (item): item is RawWebSearchCallItem =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "web_search_call",
  );
  const queries = calls.map((c) => c.action?.query).filter((q): q is string => Boolean(q));
  const sources = Array.from(new Set(calls.flatMap((c) => c.action?.sources ?? [])));
  return { called: calls.length > 0, queries, sources };
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see file header: current tool type, not yet in the bundled SDK types
    tools: config.webSearchEnabled ? ([{ type: "web_search" }] as any) : undefined,
    // Only one tool is ever offered (web_search), so forcing it forces a search
    // -- per this project's explicit requirement, never "auto" here.
    tool_choice: config.webSearchEnabled ? "required" : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see file header: not yet in the bundled SDK's ResponseIncludable union
    include: config.webSearchEnabled ? (["web_search_call.action.sources"] as any) : undefined,
  });

  const text = response.output_text?.trim() ?? "";
  if (!text) {
    throw new Error("OpenAI response had no output text (model may have only returned tool calls)");
  }

  const webSearch = extractWebSearchInfo(response.output ?? []);

  // Do not assume the tool ran just because it was offered/forced -- inspect
  // the actual output, and refuse to publish an unverified turn.
  if (config.webSearchEnabled && config.webSearchRequired && !webSearch.called) {
    throw new WebSearchNotPerformedError(
      "WEB_SEARCH_REQUIRED is set but the response contains no web_search_call -- refusing to publish an unverified turn",
    );
  }

  const usage: TokenUsage | undefined = response.usage
    ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.total_tokens,
      }
    : undefined;

  return { text, usage, webSearch };
}
