import { test } from "node:test";
import assert from "node:assert/strict";
import { makeOffer, openContract, type ContractState } from "@flop-labs/tclk";
import { planContractAction } from "./dealManager.js";

function baseState(status: ContractState["status"], overrides: Partial<ContractState> = {}): ContractState {
  const now = Date.now();
  const offer = makeOffer({
    from: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    role: "payer",
    lock: "hash",
    amount: "1",
    asset: "PAPER",
    rails: ["paper"],
    claimByMs: now + 1000,
    refundAfterMs: now + 2000,
    expiresMs: now + 500,
  });
  const state = openContract(offer);
  return { ...state, status, ...overrides };
}

test("dealManager: payer locks once accepted", () => {
  const action = planContractAction(baseState("accepted"), "payer", Date.now(), false);
  assert.deepEqual(action, { kind: "lock" });
});

test("dealManager: payee waits for lock while accepted", () => {
  const action = planContractAction(baseState("accepted"), "payee", Date.now(), false);
  assert.equal(action.kind, "none");
});

test("dealManager: payee works+reveals once locked", () => {
  const action = planContractAction(baseState("locked"), "payee", Date.now(), false);
  assert.deepEqual(action, { kind: "work_and_reveal" });
});

test("dealManager: payer refunds only at/after refundAfterMs", () => {
  const state = baseState("locked");
  const before = planContractAction(state, "payer", state.offer.refundAfterMs - 1, false);
  assert.equal(before.kind, "none");
  const after = planContractAction(state, "payer", state.offer.refundAfterMs, false);
  assert.deepEqual(after, { kind: "refund" });
});

test("dealManager: payer issues a receipt once claimed, exactly once", () => {
  const state = baseState("claimed");
  const first = planContractAction(state, "payer", Date.now(), false);
  assert.deepEqual(first, { kind: "receipt", outcome: "claimed" });
  const second = planContractAction(state, "payer", Date.now(), true);
  assert.equal(second.kind, "none");
});

test("dealManager: payee has nothing left to do once claimed", () => {
  const action = planContractAction(baseState("claimed"), "payee", Date.now(), false);
  assert.equal(action.kind, "none");
});

test("dealManager: payer issues a receipt for a refunded/cancelled contract too", () => {
  const refunded = planContractAction(baseState("refunded"), "payer", Date.now(), false);
  assert.deepEqual(refunded, { kind: "receipt", outcome: "refunded" });
  const cancelled = planContractAction(baseState("cancelled"), "payer", Date.now(), false);
  assert.deepEqual(cancelled, { kind: "receipt", outcome: "cancelled" });
});
