import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapFetchWithLogging, createTechnocoreClient } from "./http-debug.js";
import type { SonnetConfig } from "./config.js";

function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  return fn().finally(() => {
    process.stdout.write = original;
  }).then(() => lines);
}

function fakeConfig(overrides: Partial<SonnetConfig> = {}): SonnetConfig {
  return {
    enabled: true,
    dryRun: true,
    pollIntervalMs: 1000,
    actionJitterMs: 0,
    autoRegister: false,
    autoRecruit: false,
    autoTeam: false,
    autoWrite: false,
    autoSubmit: false,
    autoCampaign: false,
    technocoreBaseUrl: "https://technocore.example",
    vendorRoot: "/tmp/vendor",
    statePath: "/tmp/state.json",
    wordCachePath: "/tmp/words.json",
    eligibilityExtraRooms: [],
    recruitMinIntervalMs: 0,
    httpTimeoutMs: 1000,
    maxRetries: 0,
    httpDebug: false,
    ...overrides,
  };
}

test("wrapFetchWithLogging: logs the request method/url/headers/body and the response status/body", async () => {
  const fakeFetch = (async () =>
    new Response("hello world", { status: 200, statusText: "OK", headers: { "x-room-generation": "3" } })) as typeof fetch;
  const wrapped = wrapFetchWithLogging(fakeFetch);

  const lines = await captureLogs(async () => {
    await wrapped("https://technocore.example/r/foo?format=json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: "did:key:z6Mktest", sig: "abc", nonce: "1", text: "hi" }),
    });
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[SONNET\]\[HTTP\] --> #\d+ POST https:\/\/technocore\.example\/r\/foo\?format=json/);
  assert.match(lines[0], /headers=\{"content-type":"application\/json"\}/);
  assert.match(lines[0], /body=\{"did":"did:key:z6Mktest"/);
  assert.match(lines[1], /\[SONNET\]\[HTTP\] <-- #\d+ 200 OK/);
  assert.match(lines[1], /body=hello world/);
});

test("wrapFetchWithLogging: truncates a large response body but keeps the true byte length", async () => {
  const big = "x".repeat(5000);
  const fakeFetch = (async () => new Response(big, { status: 200 })) as typeof fetch;
  const wrapped = wrapFetchWithLogging(fakeFetch);

  const lines = await captureLogs(async () => {
    await wrapped("https://technocore.example/r/foo/export");
  });

  assert.match(lines[1], /truncated, 5000 bytes total/);
  assert.ok(!lines[1].includes("x".repeat(5000)));
});

test("wrapFetchWithLogging: logs and rethrows on a network error, without swallowing it", async () => {
  const fakeFetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  const wrapped = wrapFetchWithLogging(fakeFetch);

  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  (process.stdout.write as unknown) = (chunk: string) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    await wrapped("https://technocore.example/r/foo");
    assert.fail("expected rejection");
  } catch (err) {
    assert.equal((err as Error).message, "boom");
  } finally {
    process.stdout.write = original;
  }
  assert.equal(captured.length, 2);
  assert.match(captured[0], /--> #\d+ GET/);
  assert.match(captured[1], /<-- #\d+ network error: boom/);
});

test("createTechnocoreClient: httpDebug=false never logs (default, matches prior behavior)", async () => {
  const config = fakeConfig({ httpDebug: false });
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;

  const client = createTechnocoreClient(config, { fetchImpl: fakeFetch });
  const lines = await captureLogs(async () => {
    await client.listRooms();
  });

  assert.ok(fetchCalled);
  assert.deepEqual(lines, []);
});

test("createTechnocoreClient: httpDebug=true logs requests made through the client", async () => {
  const config = fakeConfig({ httpDebug: true });
  const fakeFetch = (async () => new Response("[]", { status: 200 })) as typeof fetch;

  const client = createTechnocoreClient(config, { fetchImpl: fakeFetch });
  const lines = await captureLogs(async () => {
    await client.listRooms();
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[SONNET\]\[HTTP\] --> #\d+ GET https:\/\/technocore\.example\/rooms/);
});
