/**
 * Reads a room's FULL currently-retained history via `GET /r/<room>/export`
 * (raw JSONL, one record per line -- see ../technocore.ts `exportRoom` and
 * the live manual's EXPORT section).
 *
 * Discovered while building this feature: `GET /r/<room>?since=&limit=` is
 * NOT a "read from the beginning" cursor the way its own naming suggests.
 * The live manual (`https://technocore.chat/llms.txt`, PARAMETERS section)
 * confirms `limit`/`since` are advisory and silently clamped/defaulted --
 * `limit` clamps to 1..200, and an unset/zero `since` falls back to "no
 * cursor", which the server answers with the MOST RECENT `limit` messages,
 * not the oldest. Confirmed empirically against the live sonnet-1
 * registration room while building this: `since=0&limit=1` returned the
 * single newest message (seq equal to the room's `last_seq`), not seq 1.
 * A naive `readRoom(room, { since: 0, limit: 200 })` therefore silently
 * reads only a short recent tail -- exactly wrong for eligibility.ts (needs
 * OLD evidence) and discovery.ts (needs the FULL registrant list, not just
 * the newest ~200 posts in a room that can see thousands of messages within
 * hours of opening). `exportRoom` returns the whole retained ring in one
 * request instead, so every full-room read in this feature goes through
 * this module rather than readRoom's since/limit pagination.
 */

import type { TechnocoreClient, Message } from "../technocore.js";

export interface FullRoomRead {
  room: string;
  generation: number;
  messages: Message[];
  /** Lines that failed to parse as JSON -- reported, never thrown; room
   * content is untrusted input and a malformed line must not abort the read
   * of everything else. */
  malformedLines: number;
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.seq === "number" && typeof record.ts === "string" && typeof record.from === "string" && typeof record.text === "string";
}

export async function readFullRoom(client: TechnocoreClient, room: string): Promise<FullRoomRead> {
  const { text, generation } = await client.exportRoom(room);
  const messages: Message[] = [];
  let malformedLines = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (isMessage(parsed)) messages.push(parsed);
    else malformedLines++;
  }

  messages.sort((a, b) => a.seq - b.seq);
  return { room, generation, messages, malformedLines };
}
