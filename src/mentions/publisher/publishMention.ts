/**
 * Publishing reuses the existing, already-signed-and-verified write path in
 * technocore.ts wholesale -- this file adds nothing to DID handling, signing, or
 * the HTTP write itself. It only (a) formats the message text and (b) wraps
 * `TechnocoreClient` with this feature's timeout/retry policy via the client's
 * existing `fetchImpl` injection point.
 *
 * IMPORTANT: Technocore messages are single-line by protocol (see technocore.ts
 * `sweepText`, reused here transitively through `sendSignedMessage`). The
 * newlines below make this readable in code; the server (via the existing sweep)
 * turns them into spaces before signing/storage. The content and order survive
 * the flattening -- just not the line breaks.
 */

import { fetchWithRetry } from "../http.js";
import { TechnocoreClient } from "../../technocore.js";
import type { Candidate } from "../types.js";
import type { MentionsConfig } from "../config.js";

export function formatMessage(candidate: Candidate, summary: string | undefined): string {
  const lines = ["New Technocore mention", "", candidate.domain, candidate.title || "(untitled)"];
  if (summary) lines.push("", summary);
  lines.push("", candidate.canonicalUrl);
  return lines.join("\n");
}

export interface PublishedMessage {
  seq: number;
}

export type SendMessageFn = (room: string, text: string) => Promise<PublishedMessage>;

/** The real sender: a TechnocoreClient whose fetch goes through this feature's
 * HTTP_TIMEOUT_MS / MAX_RETRIES, calling the existing sign-and-send path exactly
 * as-is. Nothing here touches identity.ts directly -- sendSignedMessage does. */
export function createTechnocoreSender(config: MentionsConfig): SendMessageFn {
  const client = new TechnocoreClient({
    fetchImpl: (input, init) =>
      fetchWithRetry(String(input), init ?? {}, { timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries }),
  });
  return async (room, text) => {
    const { posted } = await client.sendSignedMessage(room, text);
    return { seq: posted.seq };
  };
}
