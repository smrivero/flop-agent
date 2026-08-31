import { test } from "node:test";
import assert from "node:assert/strict";
import { determineNextSpeaker, mostRecentTurns, readDebateHistory } from "./history.js";
import { TechnocoreClient } from "../technocore.js";
import { FakeTechnocoreServer } from "./testUtils.js";
import type { AgentId } from "./types.js";

const AGENT_A_DID = "did:key:z6MkfakeAgentA0000000000000000000000000000000000";
const AGENT_B_DID = "did:key:z6MkfakeAgentB0000000000000000000000000000000000";

test("turn alternation: empty room -> Agent A starts", () => {
  assert.equal(determineNextSpeaker([]), "A");
});

test("turn alternation: after Agent A speaks, Agent B is next", () => {
  const turns = [{ seq: 1, agentId: "A" as const, did: AGENT_A_DID, text: "hi", ts: "" }];
  assert.equal(determineNextSpeaker(turns), "B");
});

test("turn alternation: after Agent B speaks, Agent A is next", () => {
  const turns = [
    { seq: 1, agentId: "A" as const, did: AGENT_A_DID, text: "hi", ts: "" },
    { seq: 2, agentId: "B" as const, did: AGENT_B_DID, text: "hello", ts: "" },
  ];
  assert.equal(determineNextSpeaker(turns), "A");
});

test("mostRecentTurns: returns only the last N, in order", () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ seq: i, agentId: (i % 2 === 0 ? "A" : "B") as AgentId, did: "x", text: `t${i}`, ts: "" }));
  const recent = mostRecentTurns(turns, 12);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].seq, 18);
  assert.equal(recent[11].seq, 29);
});

test("readDebateHistory: ignores messages from DIDs that are neither Agent A nor Agent B", async () => {
  const server = new FakeTechnocoreServer();
  server.seedMessage("d-testroom", AGENT_A_DID, "Agent A's message", 1);
  server.seedMessage("d-testroom", "did:key:z6MkSomeoneElse00000000000000000000000000000000", "an intruder's message", 1);
  server.seedMessage("d-testroom", AGENT_B_DID, "Agent B's message", 1);

  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const snapshot = await readDebateHistory(client, "d-testroom", AGENT_A_DID, AGENT_B_DID);

  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].text, "Agent A's message");
  assert.equal(snapshot.turns[1].text, "Agent B's message");
  assert.equal(determineNextSpeaker(snapshot.turns), "A"); // B spoke last among the two agents
});

test("readDebateHistory: an unwritten room has zero turns and lastSeq 0", async () => {
  const server = new FakeTechnocoreServer();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const snapshot = await readDebateHistory(client, "d-fresh-room", AGENT_A_DID, AGENT_B_DID);
  assert.equal(snapshot.turns.length, 0);
  assert.equal(snapshot.lastSeq, 0);
  assert.equal(determineNextSpeaker(snapshot.turns), "A");
});
