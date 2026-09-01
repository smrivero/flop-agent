/**
 * OpenAI relevance filter + finding extraction, via a plain fetch to the Chat
 * Completions API with structured outputs (response_format: json_schema, strict
 * mode) -- no SDK dependency, consistent with the rest of this project.
 *
 * This produces a *finding*, not a generic summary: one or two factual
 * sentences specifically about what the page says regarding Technocore,
 * suitable for another agent to independently re-check later. Relevance is
 * deliberately permissive -- a brief, genuine mention is enough; only reject a
 * different product also named "Technocore," spam, clearly unrelated pages, or
 * an accidental keyword match.
 *
 * SECURITY: never logs the API key or request headers. Errors thrown here carry
 * only status codes / short messages, never the Authorization header or the raw
 * response body (which could echo back request content).
 */

import { fetchWithRetry } from "../http.js";
import type { AnalysisResult } from "../types.js";

const SYSTEM_PROMPT = `You are Technocore Radar.

Analyze the supplied webpage.

Identify specifically what this page says about Technocore, technocore.chat, FLOP Labs in
relation to Technocore, or agents using Technocore.

Write one concise factual finding.

Rules:
- Maximum 2 sentences.
- Do not summarize unrelated parts of the article.
- Do not add information that is not present in the supplied content.
- Do not write promotional language.
- The Technocore mention can be brief. Do not reject a page merely because Technocore is not
  the main topic.
- Only return related=false when the result is clearly unrelated, spam, or refers to a
  different product also named "Technocore" (this is a real name collision -- e.g. a game,
  a company, a work of fiction -- that has nothing to do with FLOP Labs' agent protocol).
- Do not require the mention to be substantial. A single accurate sentence referencing
  Technocore, technocore.chat, or FLOP Labs in that context is enough to be related.
- If related is false, finding must be an empty string.`;

const RESPONSE_SCHEMA = {
  name: "technocore_radar_finding",
  strict: true,
  schema: {
    type: "object",
    properties: {
      related: { type: "boolean" },
      finding: { type: "string" },
    },
    required: ["related", "finding"],
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
    typeof (parsed as Record<string, unknown>).related !== "boolean" ||
    typeof (parsed as Record<string, unknown>).finding !== "string"
  ) {
    throw new Error("OpenAI response did not match the expected {related, finding} shape");
  }

  return parsed as AnalysisResult;
}
