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

/** Just the fields the message template needs -- works for a fresh Candidate or
 * a MentionRow pulled back out of the backlog, without coupling this file to
 * either shape specifically. */
export interface MessageSubject {
  canonicalUrl: string;
  title: string;
  domain: string;
}

export function formatMessage(subject: MessageSubject, summary: string | undefined): string {
  const lines = ["Technocore is popping up somewhere new!", "", `${subject.domain} — ${subject.title || "(untitled)"}`];
  if (summary) lines.push("", summary);
  lines.push("", `Go check it out -> ${subject.canonicalUrl}`);
  return lines.join("\n");
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
