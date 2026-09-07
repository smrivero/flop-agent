/**
 * Ties the deterministic summary (always computed, always available) to the
 * optional LLM rewording. The Telegram message is always the deterministic
 * template (summary/deterministic.ts's formatChangeMessage) -- reliable and
 * LLM-independent by design. The (short) Technocore summary prefers the LLM
 * wording when enabled, and silently falls back to a deterministic one-line
 * summary if the LLM is disabled or fails -- never blocks, never throws.
 */

import { buildDeterministicSummary, type ChangeSummary, type SummaryMeta } from "./deterministic.js";
import { generateLlmSummary, type LlmSummaryInput } from "./llm.js";
import type { ProtocolChange, ProtocolSource } from "../types.js";
import type { ProtocolWatcherConfig } from "../config.js";

export { buildDeterministicSummary, formatChangeMessage, type ChangeSummary, type SummaryMeta } from "./deterministic.js";

export interface TechnocoreSummaryResult {
  text: string;
  usedLlm: boolean;
  llmError?: string;
}

function shortFallback(cs: ChangeSummary): string {
  const highlights = cs.changeLines.slice(0, 3).join("; ");
  return `${cs.sourceName} changed (severity: ${cs.severity}). ${highlights}. Source: ${cs.url}`;
}

export type LlmSummaryFn = typeof generateLlmSummary;

export async function buildTechnocoreSummary(
  changeSummary: ChangeSummary,
  config: Pick<ProtocolWatcherConfig, "llmSummaryEnabled" | "openAiApiKey" | "openAiModel" | "requestTimeoutMs" | "maxRetries">,
  contradictionNote?: string,
  llmFn: LlmSummaryFn = generateLlmSummary,
): Promise<TechnocoreSummaryResult> {
  const fallback = shortFallback(changeSummary);
  if (!config.llmSummaryEnabled) return { text: fallback, usedLlm: false };
  if (!config.openAiApiKey || !config.openAiModel) return { text: fallback, usedLlm: false, llmError: "LLM summary enabled but OPENAI_API_KEY/OPENAI_MODEL missing" };

  const input: LlmSummaryInput = { changeSummary, contradictionNote };
  try {
    const text = await llmFn(input, { apiKey: config.openAiApiKey, model: config.openAiModel, timeoutMs: config.requestTimeoutMs, maxRetries: config.maxRetries });
    return { text, usedLlm: true };
  } catch (err) {
    return { text: fallback, usedLlm: false, llmError: err instanceof Error ? err.message : String(err) };
  }
}

export function summarizeForSource(source: ProtocolSource, changes: ProtocolChange[], meta: SummaryMeta): ChangeSummary {
  return buildDeterministicSummary(source, changes, meta);
}
