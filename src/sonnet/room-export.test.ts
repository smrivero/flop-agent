import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { readFullRoom } from "./room-export.js";

function exportFetch(body: string, generation = "3"): typeof fetch {
  return async () => new Response(body, { status: 200, headers: { "X-Room-Generation": generation } });
}

test("readFullRoom: parses JSONL, sorts by seq, and reports generation", async () => {
  const lines = [
    JSON.stringify({ seq: 3, ts: "t3", from: "did:key:x", text: "c", nonce: 3 }),
    JSON.stringify({ seq: 1, ts: "t1", from: "did:key:x", text: "a", nonce: 1 }),
    JSON.stringify({ seq: 2, ts: "t2", from: "did:key:x", text: "b", nonce: 2 }),
  ].join("\n");
  const client = new TechnocoreClient({ fetchImpl: exportFetch(lines) });

  const result = await readFullRoom(client, "some-room");
  assert.deepEqual(result.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(result.generation, 3);
  assert.equal(result.malformedLines, 0);
});

test("readFullRoom: skips blank lines and reports malformed ones without throwing", async () => {
  const body = [
    "not json",
    "",
    JSON.stringify({ seq: 1, ts: "t1", from: "did:key:x", text: "a", nonce: 1 }),
    JSON.stringify({ notAMessage: true }),
  ].join("\n");
  const client = new TechnocoreClient({ fetchImpl: exportFetch(body) });

  const result = await readFullRoom(client, "some-room");
  assert.equal(result.messages.length, 1);
  assert.equal(result.malformedLines, 2);
});

test("readFullRoom: an empty export yields zero messages, not an error", async () => {
  const client = new TechnocoreClient({ fetchImpl: exportFetch("") });
  const result = await readFullRoom(client, "some-room");
  assert.deepEqual(result.messages, []);
  assert.equal(result.malformedLines, 0);
});
