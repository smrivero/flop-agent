/**
 * Optional Technocore publish: a short, signed summary using Agent A's
 * EXISTING identity (TECHNOCORE_IDENTITY_PATH, loaded via identity.ts's
 * `loadIdentity` -- never generated, never a new DID). Disabled by default.
 *
 * Constraints from this feature's own requirements, each enforced here:
 *  - never publishes when the only changes are cosmetic (HTML/CSS/nav/
 *    metadata-only) -- see isPublishWorthy.
 *  - never publishes the full document -- only the short summary text
 *    (summary/index.ts's buildTechnocoreSummary output), capped defensively
 *    before it ever reaches TechnocoreClient.
 *  - never mixes this content with tclk/1 frames -- this only ever calls
 *    `sendSignedMessage` with plain text, never anything from
 *    `@flop-labs/tclk`'s frame builders.
 *  - at most one publish per source's change batch -- structural: the
 *    caller (run.ts) calls this once per source per run, with that source's
 *    already-aggregated summary, never once per individual change.
 *  - the room is whatever PROTOCOL_WATCHER_TECHNOCORE_ROOM resolves to
 *    (config.ts defaults it to "d-flop-protocol-watch", proposed but never
 *    auto-created or auto-joined by this code -- posting is the only
 *    operation here, same as the existing mentions publisher).
 */

import { TechnocoreClient, TechnocoreError } from "../../technocore.js";
import { loadIdentity } from "../../identity.js";
import type { ProtocolChange } from "../types.js";
import type { NotifyResult } from "./telegram.js";

export const TECHNOCORE_SUMMARY_CHAR_LIMIT = 3500; // headroom under the protocol's own 4096-char message cap.

/** Cosmetic-only == every change is category "other" (metadata/banner/etc.)
 * and none of them was severe enough to be action_required. Anything that
 * touches an actual protocol category (tokenomics/agent/validator/
 * verification/implementation/testnet/airdrop/tclk/settlement) is
 * publish-worthy regardless of severity. */
export function isPublishWorthy(changes: ProtocolChange[]): boolean {
  return changes.some((c) => c.category !== "other" || c.severity === "action_required");
}

export interface TechnocoreSender {
  sendSignedMessage(room: string, text: string): Promise<{ seq?: number }>;
}

/** Real sender -- loads Agent A's identity from disk (never generates one)
 * and wraps the existing, unmodified TechnocoreClient. Constructing this
 * does not publish anything by itself. */
export function createRealTechnocoreSender(options: { identityPath?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}): TechnocoreSender {
  const identity = loadIdentity({ path: options.identityPath });
  const client = new TechnocoreClient({ baseUrl: options.baseUrl, fetchImpl: options.fetchImpl });
  return {
    async sendSignedMessage(room, text) {
      try {
        const { posted } = await client.sendSignedMessage(room, text, { identity });
        return { seq: posted.seq };
      } catch (err) {
        // TechnocoreError's `.body` carries the server's actual text/plain
        // explanation (e.g. why a 400 happened) -- err.message alone is just
        // "Technocore request failed: 400 Bad Request", which was all
        // publishTechnocoreSummary's catch block ever surfaced before this,
        // making a real failure impossible to diagnose from logs/status
        // alone. Fold the body into the message here, once, for every caller.
        if (err instanceof TechnocoreError) {
          throw new Error(`${err.message}${err.body ? ` -- ${err.body.slice(0, 500)}` : ""}`);
        }
        throw err;
      }
    },
  };
}

export interface TechnocorePublishConfig {
  technocoreEnabled: boolean;
  technocoreRoom: string;
}

export async function publishTechnocoreSummary(
  config: TechnocorePublishConfig,
  changes: ProtocolChange[],
  summaryText: string,
  sender: TechnocoreSender,
  dryRun: boolean,
): Promise<NotifyResult> {
  if (!config.technocoreEnabled) return { status: "skipped" };
  if (!isPublishWorthy(changes)) return { status: "skipped", error: "cosmetic-only change (no protocol-category change), not publish-worthy" };
  if (dryRun) return { status: "dry_run" };

  const text = summaryText.length > TECHNOCORE_SUMMARY_CHAR_LIMIT ? `${summaryText.slice(0, TECHNOCORE_SUMMARY_CHAR_LIMIT - 1)}…` : summaryText;

  try {
    await sender.sendSignedMessage(config.technocoreRoom, text);
    return { status: "sent" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
