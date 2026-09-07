import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionalFetch, ResponseTooLargeError, TooManyRedirectsError, USER_AGENT } from "./http.js";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, { status, headers });
}

function withFetch(impl: (url: string, init: RequestInit) => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  // @ts-expect-error -- test stub
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const DEFAULT_OPTS = { timeoutMs: 1000, maxRetries: 1, maxRedirects: 3, maxResponseBytes: 1_000_000 };

test("http: sends If-None-Match / If-Modified-Since and a real User-Agent", async () => {
  let seenHeaders: Headers | undefined;
  await withFetch(
    async (_url, init) => {
      seenHeaders = new Headers(init.headers as Record<string, string>);
      return fakeResponse(200, "body", { "content-type": "text/html" });
    },
    async () => {
      await conditionalFetch("https://example.test/doc", { ...DEFAULT_OPTS, etag: '"abc"', lastModified: "Mon, 01 Jan 2026" });
    },
  );
  assert.equal(seenHeaders?.get("if-none-match"), '"abc"');
  assert.equal(seenHeaders?.get("if-modified-since"), "Mon, 01 Jan 2026");
  assert.equal(seenHeaders?.get("user-agent"), USER_AGENT);
});

test("http: a 304 short-circuits with notModified=true and no body", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return fakeResponse(304, "");
    },
    async () => {
      const result = await conditionalFetch("https://example.test/doc", DEFAULT_OPTS);
      assert.equal(result.notModified, true);
      assert.equal(result.status, 304);
      assert.equal(result.body, "");
    },
  );
  assert.equal(calls, 1, "a 304 must not be retried");
});

test("http: exposes etag/last-modified/content-type from the response", async () => {
  await withFetch(
    async () => fakeResponse(200, "hello", { etag: '"v2"', "last-modified": "Tue, 02 Jan 2026", "content-type": "text/markdown" }),
    async () => {
      const result = await conditionalFetch("https://example.test/doc", DEFAULT_OPTS);
      assert.equal(result.etag, '"v2"');
      assert.equal(result.lastModified, "Tue, 02 Jan 2026");
      assert.equal(result.contentType, "text/markdown");
      assert.equal(result.body, "hello");
    },
  );
});

test("http: retries a 500 up to maxRetries then succeeds", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls === 1) return fakeResponse(500, "boom");
      return fakeResponse(200, "ok");
    },
    async () => {
      const result = await conditionalFetch("https://example.test/doc", DEFAULT_OPTS);
      assert.equal(result.body, "ok");
    },
  );
  assert.equal(calls, 2);
});

test("http: does not retry a 404", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return fakeResponse(404, "not found");
    },
    async () => {
      await assert.rejects(() => conditionalFetch("https://example.test/doc", DEFAULT_OPTS));
    },
  );
  assert.equal(calls, 1);
});

test("http: rejects a response over the size cap via Content-Length", async () => {
  await withFetch(
    async () => fakeResponse(200, "x".repeat(10), { "content-length": "999999999" }),
    async () => {
      await assert.rejects(() => conditionalFetch("https://example.test/doc", { ...DEFAULT_OPTS, maxResponseBytes: 10 }), ResponseTooLargeError);
    },
  );
});

test("http: rejects a response over the size cap via actual streamed bytes", async () => {
  await withFetch(
    async () => fakeResponse(200, "x".repeat(100)),
    async () => {
      await assert.rejects(() => conditionalFetch("https://example.test/doc", { ...DEFAULT_OPTS, maxResponseBytes: 10 }), ResponseTooLargeError);
    },
  );
});

test("http: follows a bounded number of redirects then gives up", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return fakeResponse(302, "", { location: "https://example.test/next" });
    },
    async () => {
      await assert.rejects(
        () => conditionalFetch("https://example.test/start", { ...DEFAULT_OPTS, maxRedirects: 2, maxRetries: 0 }),
        TooManyRedirectsError,
      );
    },
  );
  assert.equal(calls, 3); // initial + 2 redirects, then the 3rd hop is the one that trips the cap
});

test("http: follows a redirect to a final 200", async () => {
  const urls: string[] = [];
  await withFetch(
    async (url) => {
      urls.push(String(url));
      if (String(url) === "https://example.test/start") return fakeResponse(301, "", { location: "https://example.test/final" });
      return fakeResponse(200, "final body");
    },
    async () => {
      const result = await conditionalFetch("https://example.test/start", DEFAULT_OPTS);
      assert.equal(result.body, "final body");
      assert.equal(result.finalUrl, "https://example.test/final");
    },
  );
  assert.deepEqual(urls, ["https://example.test/start", "https://example.test/final"]);
});
