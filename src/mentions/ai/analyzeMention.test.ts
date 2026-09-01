import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMention } from "./analyzeMention.js";

/** Temporarily replaces global fetch for one test, then restores it -- never
 * touches the real OpenAI API. */
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

test("analyzeMention: parses a well-formed {related, finding} response", async () => {
  const body = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ related: true, finding: "A specific claim about Technocore." }) } }],
  });
  const result = await withMockFetch(new Response(body, { status: 200 }), () =>
    analyzeMention({ title: "t", url: "https://example.com", snippet: "s" }, OPTIONS),
  );
  assert.equal(result.related, true);
  assert.equal(result.finding, "A specific claim about Technocore.");
});

test("analyzeMention: a non-2xx response includes the response body in the thrown error, not just the status", async () => {
  const errorBody = JSON.stringify({ error: { message: "Invalid value for temperature", type: "invalid_request_error" } });
  await assert.rejects(
    () =>
      withMockFetch(new Response(errorBody, { status: 400 }), () =>
        analyzeMention({ title: "t", url: "https://example.com", snippet: "s" }, OPTIONS),
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HTTP 400/);
      assert.match(err.message, /Invalid value for temperature/);
      return true;
    },
  );
});

test("analyzeMention: never includes the API key in a thrown error message", async () => {
  const errorBody = JSON.stringify({ error: { message: "rate limited" } });
  try {
    await withMockFetch(new Response(errorBody, { status: 429 }), () =>
      analyzeMention({ title: "t", url: "https://example.com", snippet: "s" }, { ...OPTIONS, apiKey: "sk-super-secret-value" }),
    );
    assert.fail("expected analyzeMention to throw");
  } catch (err) {
    assert.ok(!String(err).includes("sk-super-secret-value"));
  }
});

test("analyzeMention: throws clearly on a malformed (non-JSON) message content", async () => {
  const body = JSON.stringify({ choices: [{ message: { content: "not json" } }] });
  await assert.rejects(() =>
    withMockFetch(new Response(body, { status: 200 }), () =>
      analyzeMention({ title: "t", url: "https://example.com", snippet: "s" }, OPTIONS),
    ),
  );
});
