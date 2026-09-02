/**
 * Deal Manager: the role-aware state machine driver for a contract this
 * worker is a party to (either payer or payee -- unlike src/tclk/payer.ts and
 * verifierWorker.ts, which are two separate scripts each hardcoded to one
 * role, this worker can be EITHER side of EITHER of its own deals, so one
 * driver has to cover both).
 *
 * `planContractAction` is pure (mirrors payer.ts/verifierWorker.ts's own
 * `planPayerAction`/`planVerifierAction` -- no I/O, fully unit-testable) and
 * NEVER trusts anything but the folded transcript state (`ContractState` from
 * `@flop-labs/tclk`'s own `applyFrame`) plus our own local "did we already
 * post a receipt for this" flag. worker.ts is the only place that actually
 * posts frames / runs the executor / calls the rail.
 */

import type { ContractState } from "@flop-labs/tclk";

export type ContractAction =
  | { kind: "none"; reason: string }
  | { kind: "lock" }
  | { kind: "refund" }
  | { kind: "work_and_reveal" }
  | { kind: "receipt"; outcome: "claimed" | "refunded" | "cancelled" };

export function planContractAction(state: ContractState, role: "payer" | "payee", nowMs: number, receipted: boolean): ContractAction {
  switch (state.status) {
    case "proposed":
      return { kind: "none", reason: role === "payer" ? "waiting for accept" : "not accepted yet" };

    case "accepted":
      if (role === "payer") return { kind: "lock" };
      return { kind: "none", reason: "waiting for the payer to lock" };

    case "locked":
      if (role === "payee") return { kind: "work_and_reveal" };
      if (nowMs >= state.offer.refundAfterMs) return { kind: "refund" };
      return { kind: "none", reason: "locked, waiting for reveal (before refund window)" };

    case "claimed":
      if (receipted) return { kind: "none", reason: "terminal: claimed (receipted)" };
      if (role === "payer") return { kind: "receipt", outcome: "claimed" };
      return { kind: "none", reason: "claimed -- nothing further for the payee to do" };

    case "refunded":
      if (receipted) return { kind: "none", reason: "terminal: refunded (receipted)" };
      if (role === "payer") return { kind: "receipt", outcome: "refunded" };
      return { kind: "none", reason: "terminal: refunded" };

    case "cancelled":
      if (receipted) return { kind: "none", reason: "terminal: cancelled (receipted)" };
      if (role === "payer") return { kind: "receipt", outcome: "cancelled" };
      return { kind: "none", reason: "terminal: cancelled" };
  }
}

/** Whether a contract's cached_status should be treated as fully done (no
 * further scanning of its deal room needed) -- used by worker.ts to decide
 * when to write the `*_receipted` marker database.ts's listOpenContracts
 * checks for. */
export function isFullyDone(action: ContractAction, status: ContractState["status"], receipted: boolean): boolean {
  return (status === "refunded" || status === "cancelled") && receipted && action.kind === "none";
}
