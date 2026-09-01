/**
 * Publishing reuses the existing, already-signed-and-verified write path in
 * technocore.ts wholesale -- this file adds nothing to DID handling, signing, or
 * the HTTP write itself. It only (a) formats the message text and (b) wraps
 * `TechnocoreClient` with this feature's timeout policy via the client's existing
 * `fetchImpl` injection point.
 *
 * IMPORTANT -- timeout only, deliberately NO retry here (unlike the search/AI/
 * fetch helpers): a signed write's URL embeds its nonce. If the first attempt
 * times out client-side after the server already accepted and stored it,
 * retrying the identical URL resends the same nonce, which the server correctly
 * rejects as replay (403) -- and that rejection would look like total failure
 * even though the message already posted. Retrying is only safe for read-only /
 * idempotent calls (Tavily, SearXNG, OpenAI, article fetch), never for this one.
 * A real failure here (timeout, network error, genuine 4xx/5xx) is just reported
 * as failed -- no automatic retry with a fresh nonce, to keep this behavior
 * simple and never risk a double-post either.
 *
 * IMPORTANT -- Technocore messages are single-line by protocol (see technocore.ts
 * `sweepText`, reused here transitively through `sendSignedMessage`). The
 * newlines below make this readable in code; the server (via the existing sweep)
 * turns them into spaces before signing/storage. The content and order survive
 * the flattening -- just not the line breaks.
 */

import { fetchWithTimeout } from "../http.js";
import { TechnocoreClient } from "../../technocore.js";
import type { MentionsConfig } from "../config.js";
import type { AggregatedActivity } from "../database.js";

/** Just the fields the message template needs -- works for a fresh Candidate or
 * a MentionRow pulled back out of the backlog, without coupling this file to
 * either shape specifically. */
export interface MessageSubject {
  findingId: string;
  canonicalUrl: string;
  title: string;
  domain: string;
}

/**
 * The finding message: a short, verifiable claim, not a link dump. `finding`
 * is the 1-2 sentence factual claim from analyzeMention.ts (or omitted
 * entirely when GENERATE_SUMMARY=false -- the ID, title and URL alone are
 * still a valid, checkable finding). `contentHashShort`, when given, is the
 * only trace of the evidence hash that appears in the public message -- the
 * full hash always lives in SQLite regardless (PUBLISH_CONTENT_HASH just
 * controls whether the short form is *also* visible in the room).
 */
export function formatMessage(subject: MessageSubject, finding: string | undefined, contentHashShort: string | undefined): string {
  const lines = [
    "Technocore Radar",
    "",
    `Finding: ${subject.findingId}`,
    `Source: ${subject.domain}`,
    `Title: ${subject.title || "(untitled)"}`,
  ];
  if (finding) lines.push("", "Finding:", finding);
  lines.push("", "Source:", subject.canonicalUrl);
  if (contentHashShort) lines.push("", `Evidence: sha256:${contentHashShort}`);
  return lines.join("\n");
}

/** Optional, at most once per 24h, gated entirely outside this function (see
 * database.ts getLastDailyStatusAt / run.ts) -- this only formats real,
 * measured numbers, never invents or estimates anything. */
export function formatDailyStatusMessage(activity: AggregatedActivity): string {
  return [
    "Technocore Radar Status",
    "",
    `Searches: ${activity.searches}`,
    `Results inspected: ${activity.resultsInspected}`,
    `Duplicates: ${activity.duplicates}`,
    `New findings: ${activity.newFindings}`,
  ].join("\n");
}

export interface PublishedMessage {
  seq: number;
}

export type SendMessageFn = (room: string, text: string) => Promise<PublishedMessage>;

/** The real sender: a TechnocoreClient whose fetch goes through this feature's
 * HTTP_TIMEOUT_MS (no retry -- see the file-level comment on why), calling the
 * existing sign-and-send path exactly as-is. Nothing here touches identity.ts
 * directly -- sendSignedMessage does. */
export function createTechnocoreSender(config: MentionsConfig): SendMessageFn {
  const client = new TechnocoreClient({
    fetchImpl: (input, init) => fetchWithTimeout(String(input), init ?? {}, config.httpTimeoutMs),
  });
  return async (room, text) => {
    const { posted } = await client.sendSignedMessage(room, text);
    return { seq: posted.seq };
  };
}
