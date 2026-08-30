/**
 * OpenAI relevance filter + short summary, via a plain fetch to the Chat
 * Completions API with structured outputs (response_format: json_schema, strict
 * mode) -- no SDK dependency, consistent with the rest of this project.
 *
 * SECURITY: never logs the API key or request headers. Errors thrown here carry
 * only status codes / short messages, never the Authorization header or the raw
 * response body (which could echo back request content).
 */

import { fetchWithRetry } from "../http.js";
import type { AnalysisResult } from "../types.js";

const SYSTEM_PROMPT = `You are evaluating a web page found by a search agent.

Determine if this page contains a meaningful mention of:
- Technocore
- FLOP Labs
- technocore.chat
- or the Technocore agent communication protocol

Rules:
- The mention must be meaningful, not an accidental keyword match.
- The summary must explain specifically what the page says about Technocore.
- Maximum 2 sentences.
- Do not add information that is not present in the supplied content.
- Do not give opinions.
- Do not advertise.
- If it is not genuinely relevant, return relevant=false and an empty summary.`;

const RESPONSE_SCHEMA = {
  name: "technocore_mention_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      relevant: { type: "boolean" },
      summary: { type: "string" },
    },
    required: ["relevant", "summary"],
    additionalProperties: false,
  },
} as const;

export interface AnalyzeMentionInput {
  title: string;
  url: string;
  snippet: string;
  /** Extracted page text, if a fetch succeeded; otherwise title/snippet alone. */
  content?: string;
}

export interface AnalyzeMentionOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export async function analyzeMention(input: AnalyzeMentionInput, options: AnalyzeMentionOptions): Promise<AnalysisResult> {
  const userContent = [
    `URL: ${input.url}`,
    `Title: ${input.title}`,
    `Search snippet: ${input.snippet}`,
    input.content ? `Page content:\n${input.content}` : "Page content: (not available -- use the title and snippet above)",
  ].join("\n\n");

  const response = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries },
  );

  if (!response.ok) {
    throw new Error(`OpenAI request failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI response had no message content");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI response content was not valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).relevant !== "boolean" ||
    typeof (parsed as Record<string, unknown>).summary !== "string"
  ) {
    throw new Error("OpenAI response did not match the expected {relevant, summary} shape");
  }

  return parsed as AnalysisResult;
}
