import { test } from "node:test";
import assert from "node:assert/strict";
import { TechnocoreClient } from "../technocore.js";
import { ensureRoomOwnership, RoomOwnershipConflictError } from "./ownership.js";
import { FakeTechnocoreServer, makeTestIdentity } from "./testUtils.js";
import type { LoadedAgent } from "./types.js";

function asAgent(id: "A" | "B", identity: ReturnType<typeof makeTestIdentity>, name: string): LoadedAgent {
  return {
    id,
    name,
    position: "p",
    opponentName: "opp",
    opponentPosition: "op",
    personality: "x",
    did: identity.did,
    sign: identity.sign,
  };
}

test("room ownership setup: claims an unowned room and allow-lists Agent B", async () => {
  const server = new FakeTechnocoreServer();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const agentA = asAgent("A", makeTestIdentity(), "agent-a");
  const agentB = asAgent("B", makeTestIdentity(), "agent-b");

  const result = await ensureRoomOwnership(client, agentA, agentB, "d-testroom", "https://technocore.chat");

  assert.equal(result.claimed, true);
  assert.equal(result.allowListUpdated, true);
  assert.equal(await client.readNote("room-owners", "d-testroom"), agentA.did);
  assert.equal(await client.readNote("room-allow", "d-testroom"), agentB.did);
});

test("room ownership setup: idempotent -- running it again is a no-op", async () => {
  const server = new FakeTechnocoreServer();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const agentA = asAgent("A", makeTestIdentity(), "agent-a");
  const agentB = asAgent("B", makeTestIdentity(), "agent-b");

  const first = await ensureRoomOwnership(client, agentA, agentB, "d-testroom", "https://technocore.chat");
  assert.equal(first.claimed, true);

  const second = await ensureRoomOwnership(client, agentA, agentB, "d-testroom", "https://technocore.chat");
  assert.equal(second.claimed, false); // already owned by Agent A
  assert.equal(second.allowListUpdated, false); // Agent B already listed
});

test("room ownership setup: preserves other DIDs already on the allow-list", async () => {
  const server = new FakeTechnocoreServer();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const agentA = asAgent("A", makeTestIdentity(), "agent-a");
  const agentB = asAgent("B", makeTestIdentity(), "agent-b");
  const someoneElse = makeTestIdentity();

  await ensureRoomOwnership(client, agentA, agentB, "d-testroom", "https://technocore.chat");
  // Simulate a third key having been added by hand before Agent B's setup ran.
  const currentAllow = await client.readNote("room-allow", "d-testroom");
  assert.ok(currentAllow);

  // Re-run with a fresh call after manually appending a third DID to the note,
  // signed by the owner (agentA), to confirm a subsequent ensureRoomOwnership
  // call doesn't wipe it.
  const combined = `${currentAllow} ${someoneElse.did}`;
  const { buildSignedNoteRequest } = await import("../technocore.js");
  const nonce = String(Date.now() + 1000);
  const built = buildSignedNoteRequest("room-allow", "d-testroom", combined, { identity: agentA, nonce });
  await client.setSignedNote(built);

  const result = await ensureRoomOwnership(client, agentA, agentB, "d-testroom", "https://technocore.chat");
  assert.equal(result.allowListUpdated, false); // agentB already there, nothing to add
  const finalAllow = await client.readNote("room-allow", "d-testroom");
  assert.ok(finalAllow?.includes(someoneElse.did));
  assert.ok(finalAllow?.includes(agentB.did));
});

test("room ownership setup: refuses to hijack a room owned by a different DID", async () => {
  const server = new FakeTechnocoreServer();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const stranger = asAgent("A", makeTestIdentity(), "stranger");
  const agentA = asAgent("A", makeTestIdentity(), "agent-a");
  const agentB = asAgent("B", makeTestIdentity(), "agent-b");

  // Someone else claims the room first.
  await ensureRoomOwnership(client, stranger, agentB, "d-contested", "https://technocore.chat");

  await assert.rejects(
    () => ensureRoomOwnership(client, agentA, agentB, "d-contested", "https://technocore.chat"),
    RoomOwnershipConflictError,
  );
  // And it must NOT have overwritten the owner note.
  assert.equal(await client.readNote("room-owners", "d-contested"), stranger.did);
});

test("room ownership setup: refuses to claim a room that already has messages and no owner", async () => {
  const server = new FakeTechnocoreServer();
  server.seedMessage("d-already-active", "did:key:z6MkSomeNick0000000000000000000000000000000000000", "hi");
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const agentA = asAgent("A", makeTestIdentity(), "agent-a");
  const agentB = asAgent("B", makeTestIdentity(), "agent-b");

  await assert.rejects(
    () => ensureRoomOwnership(client, agentA, agentB, "d-already-active", "https://technocore.chat"),
    RoomOwnershipConflictError,
  );
});

test("room ownership setup: only the current owner may write the allow-list", async () => {
  const server = new FakeTechnocoreServer();
  const client = new TechnocoreClient({ fetchImpl: server.fetch });
  const agentA = asAgent("A", makeTestIdentity(), "agent-a");
  const agentB = asAgent("B", makeTestIdentity(), "agent-b");
  await ensureRoomOwnership(client, agentA, agentB, "d-testroom", "https://technocore.chat");

  const { buildSignedNoteRequest } = await import("../technocore.js");
  const impostor = makeTestIdentity();
  const built = buildSignedNoteRequest("room-allow", "d-testroom", impostor.did, { identity: impostor, nonce: String(Date.now() + 99999) });
  await assert.rejects(() => client.setSignedNote(built));
});
