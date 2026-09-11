/**
 * LLM ranking over an ALREADY mechanically-legal candidate set
 * (candidate-generator.ts). The model never sees free rein: it must choose
 * exactly one word from the candidate list it's given, and the choice is
 * re-verified against that same list before being trusted (never just
 * against the dictionary/DID rules again -- this is a stricter, closed-set
 * check). Same plain-fetch Chat Completions + strict JSON schema pattern as
 * verifier/openai.ts / mentions/ai/analyzeMention.ts -- no SDK, no
 * dependency beyond what this project already uses elsewhere.
 *
 * Never sent to the model: private key material, other contributors'
 * unpublished plans, anything outside the poem/candidates/rhyme context
 * below.
 */

import { fetchWithRetry } from "../mentions/http.js";
import { sonnetLog } from "./logger.js";
import type { Candidate } from "./candidate-generator.js";
import type { AuthoritativePoemState } from "./room-poller.js";
import type { RhymeIndex } from "./rhyme.js";

export class PoetryPlannerError extends Error {}

// ABAB CDCD EFEF GG: for a line at this index, which earlier line (if any)
// it should rhyme with -- sonnet-game.md's target scheme, a literary goal
// assessed by judges, never an eligibility gate (see rhyme.ts's header).
const RHYME_PARTNER: Record<number, number> = { 2: 0, 3: 1, 6: 4, 7: 5, 10: 8, 11: 9, 13: 12 };
const RHYME_LETTER = ["A", "B", "A", "B", "C", "D", "C", "D", "E", "F", "E", "F", "G", "G"];

/** The word this line should try to rhyme with, if its partner line (per
 * ABAB CDCD EFEF GG) is already complete -- undefined otherwise (no target
 * yet, or this line has no partner, e.g. the first line of each group). */
export function targetRhymeWord(poem: AuthoritativePoemState, lineIndex: number): string | undefined {
  const partnerIndex = RHYME_PARTNER[lineIndex];
  if (partnerIndex === undefined) return undefined;
  const partnerLine = poem.lines[partnerIndex];
  if (!partnerLine || partnerLine.syllables < 10 || partnerLine.words.length === 0) return undefined;
  return partnerLine.words[partnerLine.words.length - 1].word.toLowerCase();
}

function poemTextSoFar(poem: AuthoritativePoemState): string {
  return poem.lines
    .map((line, i) => `${i + 1}. [${RHYME_LETTER[i]}] ${line.words.map((w) => w.word).join(" ")}${line.words.length > 0 ? "" : "(empty)"}`)
    .join("\n");
}

const SYSTEM_PROMPT = `You are choosing the next word for a collaborative sonnet, one word per turn, written by a team of agents.

Rules you MUST follow:
- You may choose ONLY one word from the "candidates" list given to you. Copy it EXACTLY
  (same spelling, same case) -- do not invent, pluralize, conjugate, or modify it in any way.
- Each line must reach exactly 10 syllables; candidates are already filtered to fit the
  remaining budget for the current line, so any candidate is mechanically legal.
- Prefer iambic pentameter (alternating unstressed/stressed syllables) and, when the current
  line is close to a target rhyme, a word that rhymes with the given target -- both are
  literary goals, not hard requirements; never pick a nonsensical word just to satisfy them.
- Aim for semantic coherence with the poem so far -- avoid repeating a word already used
  unless it's a common function word (the, a, and, ...).
- confidence is your own 0-1 estimate of how good this choice is, not a probability of anything else.`;

const RESPONSE_SCHEMA = {
  name: "sonnet_word_choice",
  strict: true,
  schema: {
    type: "object",
    properties: {
      word: { type: "string" },
      reason: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["word", "reason", "confidence"],
    additionalProperties: false,
  },
} as const;

export interface PlanNextWordOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  /** Cap on candidates actually shown to the model -- keeps the prompt
   * bounded even when the mechanical set is large. Rhyme-matching
   * candidates are always kept first. */
  maxCandidatesShown?: number;
}

export interface PlannedWord {
  word: string;
  reason: string;
  confidence: number;
}

function shortlist(candidates: readonly Candidate[], limit: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => Number(b.rhymesWithTarget ?? false) - Number(a.rhymesWithTarget ?? false));
  return sorted.slice(0, limit);
}

/**
 * Asks the model to pick one word from `candidates` for `lineIndex` (0-13)
 * of `poem`. Throws PoetryPlannerError if the model's choice isn't EXACTLY
 * one of the candidates it was shown -- this is the closed-set re-check the
 * operator's own instruction requires ("Verificar de nuevo que `word`
 * pertenezca exactamente a legalCandidates. Si no: rechazar."), independent
 * of and in addition to validator.ts's later mechanical re-check.
 */
export async function planNextWord(
  poem: AuthoritativePoemState,
  lineIndex: number,
  candidates: readonly Candidate[],
  rhymeIndex: RhymeIndex,
  options: PlanNextWordOptions,
): Promise<PlannedWord> {
  if (candidates.length === 0) throw new PoetryPlannerError("no legal candidates to choose from");

  const shown = shortlist(candidates, options.maxCandidatesShown ?? 60);
  const target = targetRhymeWord(poem, lineIndex);
  const remainingSyllables = 10 - poem.lines[lineIndex].syllables;

  const userContent = [
    `Poem so far (14 lines, 4/4/4/2 stanzas, target rhyme scheme ABAB CDCD EFEF GG):`,
    poemTextSoFar(poem),
    ``,
    `You are choosing a word for line ${lineIndex + 1} (rhyme letter ${RHYME_LETTER[lineIndex]}), which currently has ${poem.lines[lineIndex].syllables} of 10 syllables (${remainingSyllables} remaining).`,
    target ? `Target rhyme word for this line's ending (if you pick a line-closing candidate): "${target}".` : `No rhyme target is established yet for this line.`,
    ``,
    `Candidates (word:syllables${target ? ", * = rhymes with the target" : ""}):`,
    shown.map((c) => `${c.word}:${c.syllables}${c.rhymesWithTarget ? "*" : ""}`).join(", "),
  ].join("\n");

  const response = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        temperature: 0.4,
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
    const body = await response.text().catch(() => "");
    throw new PoetryPlannerError(`OpenAI request failed: HTTP ${response.status}${body ? ` -- ${body.slice(0, 300)}` : ""}`);
  }

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new PoetryPlannerError("OpenAI response had no message content");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PoetryPlannerError("OpenAI response content was not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).word !== "string" ||
    typeof (parsed as Record<string, unknown>).reason !== "string" ||
    typeof (parsed as Record<string, unknown>).confidence !== "number"
  ) {
    throw new PoetryPlannerError("OpenAI response did not match the expected {word, reason, confidence} shape");
  }
  const choice = parsed as PlannedWord;

  // The mandatory closed-set re-check -- the model's own claim that it chose
  // a legal word is never trusted on its own.
  if (!shown.some((c) => c.word === choice.word)) {
    sonnetLog("LLM", `model chose ${JSON.stringify(choice.word)}, which is NOT in the candidate set shown -- rejecting`);
    throw new PoetryPlannerError(`model chose a word outside the candidate set: ${JSON.stringify(choice.word)}`);
  }

  sonnetLog("LLM", `selected=${JSON.stringify(choice.word)} confidence=${choice.confidence}`);
  return choice;
}
