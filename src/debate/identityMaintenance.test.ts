import { test } from "node:test";
import assert from "node:assert/strict";
import { isIdentityRefreshDue, refreshIdentityNote } from "./identityMaintenance.js";
import { didNoteShardedPath } from "../identity.js";
import { TechnocoreClient } from "../technocore.js";
import { makeTestIdentity, buildTestAgent } from "./testUtils.js";

test("isIdentityRefreshDue: true when never refreshed", () => {
  assert.equal(isIdentityRefreshDue(null, 72), true);
});

test("isIdentityRefreshDue: false well within the window", () => {
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(isIdentityRefreshDue(oneHourAgo, 72), false);
});

test("isIdentityRefreshDue: true once the window elapses (comfortably before the 7-day note TTL)", () => {
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600_000).toISOString();
  assert.equal(isIdentityRefreshDue(fourDaysAgo, 72), true);
});

test("refreshIdentityNote: writes to the agent's OWN sharded DID-note path, and only that path", async () => {
  const identity = makeTestIdentity();
  const agent = buildTestAgent("A", identity, "cules-ai", "madridista-ai");
  const { ns, key } = didNoteShardedPath(agent.did);

  const writes: { ns: string; key: string; value: string }[] = [];
  const client = new TechnocoreClient({
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      const parts = url.pathname.split("/").filter(Boolean);
      // GET /kv/<ns>/<key>/set/<value>
      if (parts[0] === "kv" && parts[3] === "set") {
        writes.push({ ns: parts[1], key: parts[2], value: decodeURIComponent(parts[4]) });
        return new Response(JSON.stringify({ ns: parts[1], key: parts[2] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("404", { status: 404 });
    }) as typeof fetch,
  });

  await refreshIdentityNote(client, agent);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].ns, ns);
  assert.equal(writes[0].key, key);
  assert.equal(writes[0].value, agent.did); // bare DID -- no x25519/mailbox fields, this agent has neither
});

test("refreshIdentityNote: never touches the debate room or any other note namespace", async () => {
  const identity = makeTestIdentity();
  const agent = buildTestAgent("B", identity, "madridista-ai", "cules-ai");
  let calls = 0;
  const client = new TechnocoreClient({
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      calls++;
      const url = new URL(String(input));
      assert.ok(!url.pathname.startsWith("/r/"), `unexpected room write: ${url.pathname}`);
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });

  await refreshIdentityNote(client, agent);
  assert.equal(calls, 1); // exactly one write, the note itself
});
