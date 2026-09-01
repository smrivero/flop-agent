/**
 * Independent re-check of a Radar finding, via the same plain-fetch Chat
 * Completions pattern as mentions/ai/analyzeMention.ts (structured outputs,
 * strict schema, no SDK). The only input that matters here is content THIS
 * module fetched itself -- callers must never pass Radar's stored `finding`
 * text as if it were source material; see verifier/run.ts, which fetches the
 * URL fresh before calling this.
 */

import { fetchWithRetry } from "../mentions/http.js";
import type { VerifyAnalysisInput, VerifyAnalysisResult } from "./types.js";

const SYSTEM_PROMPT = `You are Technocore Verifier, an independent auditor of Technocore Radar's findings.

You will be given:
1. Radar's original finding -- a factual claim about what a webpage says regarding Technocore.
2. The actual current content of that webpage, fetched independently just now (NOT by Radar).

Decide whether the original finding is an accurate, supportable claim about the independently-fetched
content.

Rules:
- Judge only the ACCURACY of the finding against the fetched content -- not its writing style,
  completeness, or importance.
- VERIFIED means: the fetched content genuinely supports the finding as stated. Minor phrasing
  differences are fine. The content does not need to say it in exactly the same words.
- REJECTED means: the fetched content does NOT support the finding -- it says something different,
  the claimed Technocore/FLOP Labs mention is not actually present, or the finding materially
  overstates or misrepresents what the page says.
- If the page is now unavailable, empty, or clearly a different page than what Radar likely saw,
  treat that as grounds for REJECTED with a reason explaining the mismatch -- but this function is
  only called when a fetch already succeeded, so "page unreachable" is not a case you need to invent.
- reason must be one concise sentence explaining the verdict by referring to what the fetched content
  actually says (or doesn't say).`;

const RESPONSE_SCHEMA = {
  name: "technocore_verifier_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      result: { type: "string", enum: ["VERIFIED", "REJECTED"] },
      reason: { type: "string" },
    },
    required: ["result", "reason"],
    additionalProperties: false,
  },
} as const;

export interface VerifyAnalysisOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export async function verifyAnalysis(input: VerifyAnalysisInput, options: VerifyAnalysisOptions): Promise<VerifyAnalysisResult> {
  const userContent = [
    `Radar's original finding:\n${input.originalFinding}`,
    `Independently fetched page content:\n${input.sourceContent}`,
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
    // Same rationale as analyzeMention.ts: the OpenAI error body describes the
    // request problem, never echoes the Authorization header or API key.
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI request failed: HTTP ${response.status}${body ? ` -- ${body.slice(0, 300)}` : ""}`);
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
    ((parsed as Record<string, unknown>).result !== "VERIFIED" && (parsed as Record<string, unknown>).result !== "REJECTED") ||
    typeof (parsed as Record<string, unknown>).reason !== "string"
  ) {
    throw new Error("OpenAI response did not match the expected {result, reason} shape");
  }

  return parsed as VerifyAnalysisResult;
}
