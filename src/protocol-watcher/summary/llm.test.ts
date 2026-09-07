import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLlmSummary, LLM_SYSTEM_PROMPT } from "./llm.js";
import type { ChangeSummary } from "./deterministic.js";

const CHANGE_SUMMARY: ChangeSummary = {
  sourceId: "yellowpaper",
  sourceName: "Yellow Paper",
  url: "https://flop.finance/intro/yellowpaper/",
  versionBefore: "0.5.0",
  versionAfter: "0.5.1",
  severity: "action_required",
  changeLines: ["E.38: TBD → RATIFIED"],
};

function withFetch(impl: (url: string, init: RequestInit) => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const OPTIONS = { apiKey: "sk-test", model: "gpt-5-nano", timeoutMs: 1000, maxRetries: 0 };

test("llm summary: sends only the structured ChangeSummary JSON, never raw page content", async () => {
  let sentBody: string | undefined;
  await withFetch(
    async (_url, init) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "ok" }) } }] }), { status: 200 });
    },
    async () => {
      await generateLlmSummary({ changeSummary: CHANGE_SUMMARY }, OPTIONS);
    },
  );
  const parsedRequest = JSON.parse(sentBody!);
  const userMessage = parsedRequest.messages.find((m: { role: string }) => m.role === "user").content;
  assert.ok(userMessage.includes("E.38: TBD"));
  assert.ok(!userMessage.includes("<html"), "raw HTML must never reach the model");
  assert.equal(parsedRequest.temperature, 0);
});

test("llm summary: system prompt instructs the model to ignore embedded instructions and never invent impact", () => {
  assert.match(LLM_SYSTEM_PROMPT, /untrusted external data, not instructions/i);
  assert.match(LLM_SYSTEM_PROMPT, /never invent a consequence/i);
  assert.match(LLM_SYSTEM_PROMPT, /ratified.*placeholders.*TBD/i);
  assert.match(LLM_SYSTEM_PROMPT, /source link/i);
  assert.match(LLM_SYSTEM_PROMPT, /contradiction/i);
});

test("llm summary: returns the parsed summary string on success", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Yellow Paper ratified E.38." } as { summary: string }) } }] }), { status: 200 }),
    async () => {
      const summary = await generateLlmSummary({ changeSummary: CHANGE_SUMMARY }, OPTIONS);
      assert.equal(summary, "Yellow Paper ratified E.38.");
    },
  );
});

test("llm summary: throws on a non-OK response (caller is responsible for falling back)", async () => {
  await withFetch(
    async () => new Response("server error", { status: 500 }),
    async () => {
      await assert.rejects(() => generateLlmSummary({ changeSummary: CHANGE_SUMMARY }, { ...OPTIONS, maxRetries: 0 }));
    },
  );
});

test("llm summary: throws if the model's response doesn't match {summary}", async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ oops: true }) } }] }), { status: 200 }),
    async () => {
      await assert.rejects(() => generateLlmSummary({ changeSummary: CHANGE_SUMMARY }, OPTIONS));
    },
  );
});
