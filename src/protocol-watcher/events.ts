/**
 * Maps classified ProtocolChange records to the 10 internal FLOP_* events.
 * Purely derived from already-classified changes (see classify.ts) -- no new
 * decision-making happens here, just routing. Persistence + idempotency (a
 * single run must never emit the same event twice) is database.ts's
 * insertEventIfNew; this module only decides *which* events a batch of
 * changes implies and builds their payload.
 *
 * Per this feature's own requirement, these events are inert: persisted,
 * logged, and Telegram/Technocore-notifiable, but never wired to any
 * financial action (a faucet claim, a payment, a config change). No code
 * path here or in notify/ triggers one.
 */

import type { ProtocolChange, ProtocolEvent, ProtocolEventType, ProtocolChangeSeverity } from "./types.js";

const SEVERITY_RANK: Record<ProtocolChangeSeverity, number> = { info: 0, important: 1, action_required: 2 };

function maxSeverity(changes: ProtocolChange[]): ProtocolChangeSeverity {
  return changes.reduce<ProtocolChangeSeverity>((max, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[max] ? c.severity : max), "info");
}

function fieldText(change: ProtocolChange): string {
  return (change.field ?? "").toLowerCase();
}

type EventRule = (change: ProtocolChange) => boolean;

const EVENT_RULES: [ProtocolEventType, EventRule][] = [
  ["FLOP_VALIDATOR_REQUIREMENTS_CHANGED", (c) => c.category === "validator"],
  ["FLOP_IMPLEMENTATION_STATUS_CHANGED", (c) => c.category === "implementation"],
  ["FLOP_AIRDROP_RULES_CHANGED", (c) => c.category === "airdrop" || fieldText(c).includes("vesting")],
  ["FLOP_AGENT_SCORING_RATIFIED", (c) => c.category === "agent" && c.severity === "action_required"],
  ["FLOP_TESTNET_ENDPOINT_AVAILABLE", (c) => fieldText(c).includes("testnet") && fieldText(c).includes("endpoint")],
  [
    "FLOP_INFERENCE_INTERFACE_AVAILABLE",
    (c) => (fieldText(c).includes("inference") || c.category === "agent") && (fieldText(c).includes("endpoint") || fieldText(c).includes("sdk") || fieldText(c).includes("interface")),
  ],
  ["FLOP_TESTNET_DATE_CHANGED", (c) => c.category === "testnet" && !fieldText(c).includes("endpoint")],
  ["FLOP_SPEND_TO_UNLOCK_CHANGED", (c) => fieldText(c).includes("spend_to_unlock") || fieldText(c).includes("spend-to-unlock")],
  ["FLOP_TCLK_RAIL_AVAILABLE", (c) => c.category === "tclk" && c.field === "rail_status" && c.severity === "action_required"],
];

export interface DeriveEventsContext {
  sourceId: string;
  changeBatchId: string;
  snapshotId: number;
}

/** One ProtocolEvent per unique triggered type (deduped across every change
 * in the batch) -- plus FLOP_DOCUMENT_CHANGED whenever there is at least one
 * change at all, so "something changed on this source" always has a
 * corresponding event even when no more specific rule matched. */
export function deriveEvents(changes: ProtocolChange[], ctx: DeriveEventsContext): ProtocolEvent[] {
  if (changes.length === 0) return [];

  const byType = new Map<ProtocolEventType, ProtocolChange[]>();
  for (const [eventType, rule] of EVENT_RULES) {
    const matching = changes.filter(rule);
    if (matching.length > 0) byType.set(eventType, matching);
  }
  byType.set("FLOP_DOCUMENT_CHANGED", changes);

  const events: ProtocolEvent[] = [];
  for (const [eventType, matching] of byType) {
    events.push({
      eventType,
      sourceId: ctx.sourceId,
      snapshotId: ctx.snapshotId,
      changeBatchId: ctx.changeBatchId,
      severity: maxSeverity(matching),
      payload: {
        changeCount: matching.length,
        documentVersionBefore: matching[0]?.documentVersionBefore,
        documentVersionAfter: matching[0]?.documentVersionAfter,
        items: matching.map((c) => ({ category: c.category, itemId: c.itemId, field: c.field, changeType: c.changeType, severity: c.severity })),
      },
    });
  }

  // Deterministic order: FLOP_DOCUMENT_CHANGED first, then alphabetical.
  events.sort((a, b) => {
    if (a.eventType === "FLOP_DOCUMENT_CHANGED") return -1;
    if (b.eventType === "FLOP_DOCUMENT_CHANGED") return 1;
    return a.eventType.localeCompare(b.eventType);
  });
  return events;
}
