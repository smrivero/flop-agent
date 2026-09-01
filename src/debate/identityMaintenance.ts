/**
 * Keeps each agent's DID note alive. Confirmed against the live docs
 * (llms.txt CAPACITY: "Rooms and notes with no write for 7 days are
 * deleted") before building this -- notes are NOT exempt from that just
 * because they have no ring, so a DID note published once and never touched
 * again would eventually disappear. IDENTITY_REFRESH_HOURS defaults to 72h,
 * comfortably inside the 7-day window even if a run or two is missed.
 *
 * This writes ONLY to the agent's own sharded DID-note path (patterns.md #3,
 * identity.ts `didNoteShardedPath`) via the plain unsigned note lane
 * (`writeNote` -- that namespace takes no signed writes; the convention's own
 * trust model is "your signed messages verify against the did inside it," not
 * a signature on the note itself). It never touches the debate room -- see
 * the file-level requirement that identity maintenance and debate messages
 * are different concerns, so this is called from loop.ts as an independent
 * per-iteration side check, same shape as archive.ts, and a failure here must
 * never affect message generation/publishing.
 */

import type { TechnocoreClient } from "../technocore.js";
import { didNoteShardedPath } from "../identity.js";
import type { LoadedAgent } from "./types.js";

export function isIdentityRefreshDue(lastRefreshAt: string | null, refreshHours: number, now: Date = new Date()): boolean {
  if (lastRefreshAt === null) return true;
  const last = new Date(lastRefreshAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= refreshHours * 3600_000;
}

/** Refreshes one agent's DID note -- just the bare did:key, the minimum valid
 * form of the pattern (no x25519/mailbox fields: these agents have neither). */
export async function refreshIdentityNote(client: TechnocoreClient, agent: LoadedAgent): Promise<void> {
  const { ns, key } = didNoteShardedPath(agent.did);
  await client.writeNote(ns, key, agent.did);
}
