import { test } from "node:test";
import assert from "node:assert/strict";
import { planNextWord, targetRhymeWord, PoetryPlannerError } from "./poetry-planner.js";
import type { AuthoritativePoemState } from "./room-poller.js";
import type { Candidate } from "./candidate-generator.js";
import type { RhymeIndex } from "./rhyme.js";

async function withMockFetch<T>(response: Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const OPTIONS = { apiKey: "sk-test", model: "gpt-test", timeoutMs: 5000, maxRetries: 0 };

function emptyPoemState(): AuthoritativePoemState {
  return {
    version: 0,
    previousStateHash: "",
    hashKnown: true,
    lines: Array.from({ length: 14 }, () => ({ words: [], syllables: 0 })),
    currentLineIndex: 0,
    currentLineSyllables: 0,
    complete: false,
    lastProcessedSeq: 0,
    unrecognizedRefereeMessages: 0,
  };
}

const CANDIDATES: Candidate[] = [
  { word: "the", syllables: 1 },
  { word: "sky", syllables: 1 },
  { word: "blue", syllables: 1 },
];

const EMPTY_RHYME_INDEX: RhymeIndex = new Map();

function llmResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status });
}

test("planNextWord: accepts a model choice that IS in the shown candidate set", async () => {
  const result = await withMockFetch(llmResponse({ word: "sky", reason: "fits the meter", confidence: 0.8 }), () =>
    planNextWord(emptyPoemState(), 0, CANDIDATES, EMPTY_RHYME_INDEX, OPTIONS),
  );
  assert.equal(result.word, "sky");
  assert.equal(result.confidence, 0.8);
});

test("planNextWord: REJECTS a model choice outside the candidate set, even if plausible-looking", async () => {
  await assert.rejects(
    () =>
      withMockFetch(llmResponse({ word: "ocean", reason: "sounds nice", confidence: 0.9 }), () =>
        planNextWord(emptyPoemState(), 0, CANDIDATES, EMPTY_RHYME_INDEX, OPTIONS),
      ),
    PoetryPlannerError,
  );
});

test("planNextWord: throws when there are no candidates at all (never calls the model)", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should not be called");
  }) as typeof fetch;
  try {
    await assert.rejects(() => planNextWord(emptyPoemState(), 0, [], EMPTY_RHYME_INDEX, OPTIONS), PoetryPlannerError);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("planNextWord: a malformed response shape is rejected", async () => {
  await assert.rejects(
    () => withMockFetch(llmResponse({ word: "sky" }), () => planNextWord(emptyPoemState(), 0, CANDIDATES, EMPTY_RHYME_INDEX, OPTIONS)),
    PoetryPlannerError,
  );
});

test("planNextWord: a non-2xx response is rejected with the HTTP status", async () => {
  await assert.rejects(
    () =>
      withMockFetch(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }), () =>
        planNextWord(emptyPoemState(), 0, CANDIDATES, EMPTY_RHYME_INDEX, OPTIONS),
      ),
    (err: unknown) => {
      assert.ok(err instanceof PoetryPlannerError);
      assert.match(err.message, /HTTP 400/);
      return true;
    },
  );
});

test("targetRhymeWord: undefined when the partner line isn't complete yet", () => {
  const state = emptyPoemState();
  assert.equal(targetRhymeWord(state, 2), undefined); // line 2 (A) partners with line 0
});

test("targetRhymeWord: undefined for a line with no rhyme partner (first of its group)", () => {
  const state = emptyPoemState();
  assert.equal(targetRhymeWord(state, 0), undefined);
  assert.equal(targetRhymeWord(state, 4), undefined);
});

test("targetRhymeWord: returns the completed partner line's last word, lowercased", () => {
  const state = emptyPoemState();
  state.lines[0] = { syllables: 10, words: [{ word: "Sky", contributorDid: "did:key:x", seq: 1, requestId: "r-1" }] };
  assert.equal(targetRhymeWord(state, 2), "sky"); // line 2 (A) partners with line 0 (A)
  assert.equal(targetRhymeWord(state, 13), undefined); // line 13's partner (12) still empty
});
