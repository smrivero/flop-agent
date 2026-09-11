import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient, type Message } from "../technocore.js";
import { checkEligibility } from "./eligibility.js";
import { loadSonnetConfig, type ContestConfig } from "./config.js";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkereFQqHaUdcF7yVmHvY1rHpAvVjeCggaBVy45hmE8G6C";

const CONTEST: ContestConfig = {
  contest_id: "sonnet-1",
  rules_version: "0.5",
  opening: "2026-09-11T12:00:00Z",
  deadline: "2026-09-18T12:00:00Z",
  prize: 50000,
  voter_pool: 50000,
  payment_unit: "FLOP",
  payment_method: "x",
  theme: null,
  identity_policy: "verified-prestart-did",
  identity_cutoff: "2026-09-11T12:00:00Z",
};

/** A minimal fetchImpl serving GET /r/<room>/export (raw JSONL, the endpoint
 * eligibility.ts actually reads via room-export.ts's readFullRoom -- see that
 * module's header for why it uses export instead of readRoom's since/limit,
 * which cannot be pointed at a specific historical timestamp deterministically
 * from a test). */
function fixedExportFetch(messages: Message[]): typeof fetch {
  const body = messages.map((m) => JSON.stringify(m)).join("\n");
  return async () => new Response(body, { status: 200, headers: { "X-Room-Generation": "0" } });
}

test("checkEligibility: reports eligible with concrete evidence when a pre-cutoff signed message from our DID exists", async () => {
  const config = loadSonnetConfig({});
  const client = new TechnocoreClient({
    fetchImpl: fixedExportFetch([{ seq: 1, ts: "2026-09-10T00:00:00.000Z", from: DID, text: "hello", nonce: 1 }]),
  });

  const result = await checkEligibility(DID, CONTEST, config, { client, env: { TECHNOCORE_ROOM: "d-technocore-radar" } });
  assert.equal(result.status, "eligible");
  assert.deepEqual(result.evidence, { room: "d-technocore-radar", seq: 1, ts: "2026-09-10T00:00:00.000Z" });
});

test("checkEligibility: a message from our DID AT/AFTER the cutoff is not accepted as evidence", async () => {
  const config = loadSonnetConfig({});
  const client = new TechnocoreClient({
    fetchImpl: fixedExportFetch([{ seq: 1, ts: "2026-09-11T12:00:00.000Z", from: DID, text: "hello", nonce: 1 }]),
  });

  const result = await checkEligibility(DID, CONTEST, config, { client, env: { TECHNOCORE_ROOM: "d-technocore-radar" } });
  assert.equal(result.status, "unknown");
  assert.equal(result.evidence, undefined);
});

test("checkEligibility: never reports eligible without evidence -- no matching messages means unknown", async () => {
  const config = loadSonnetConfig({});
  const client = new TechnocoreClient({
    fetchImpl: fixedExportFetch([{ seq: 1, ts: "2026-09-01T00:00:00.000Z", from: OTHER_DID, text: "hello", nonce: 1 }]),
  });

  const result = await checkEligibility(DID, CONTEST, config, { client, env: { TECHNOCORE_ROOM: "d-technocore-radar" } });
  assert.equal(result.status, "unknown");
  assert.ok(result.limitations.length > 0);
});

test("checkEligibility: an unreadable room is recorded as a limitation, not a crash, and still yields unknown", async () => {
  const config = loadSonnetConfig({});
  const throwingFetch: typeof fetch = async () => {
    throw new Error("network down");
  };
  const client = new TechnocoreClient({ fetchImpl: throwingFetch });

  const result = await checkEligibility(DID, CONTEST, config, { client, env: { TECHNOCORE_ROOM: "d-technocore-radar" } });
  assert.equal(result.status, "unknown");
  assert.ok(result.limitations.some((l) => l.includes("d-technocore-radar")));
});

test("checkEligibility: an empty room yields unknown, not eligible", async () => {
  const config = loadSonnetConfig({});
  const client = new TechnocoreClient({ fetchImpl: fixedExportFetch([]) });
  const result = await checkEligibility(DID, CONTEST, config, { client, env: { TECHNOCORE_ROOM: "d-technocore-radar" } });
  assert.equal(result.status, "unknown");
});

test("checkEligibility: a malformed export line is skipped, not fatal", async () => {
  const config = loadSonnetConfig({});
  const client = new TechnocoreClient({
    fetchImpl: async () =>
      new Response(
        `not json at all\n${JSON.stringify({ seq: 2, ts: "2026-09-05T00:00:00.000Z", from: DID, text: "hi", nonce: 2 })}`,
        { status: 200, headers: { "X-Room-Generation": "0" } },
      ),
  });

  const result = await checkEligibility(DID, CONTEST, config, { client, env: { TECHNOCORE_ROOM: "d-technocore-radar" } });
  assert.equal(result.status, "eligible");
  assert.ok(result.limitations.some((l) => l.includes("could not be parsed")));
});
