/**
 * LIVE ONLY. The real HTTP transport for journal.ts: signed POSTs to technocore.chat,
 * plus the read-backs recovery needs. Not imported anywhere outside live/ and not
 * reachable in this build (live mode refuses to start).
 */

import { TransportTimeout, type RoomMessage, type Transport, type TransportResponse } from "../journal.js";

export class HttpTransport implements Transport {
  constructor(private baseUrl: string, private timeoutMs = 20_000, private fetchImpl: typeof fetch = fetch) {}

  async post(path: string, body: unknown): Promise<TransportResponse> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      throw new TransportTimeout((e as Error).message);
    }
  }

  async readRoom(room: string, since: number): Promise<{ first_seq: number | null; last_seq: number; messages: RoomMessage[] }> {
    const res = await this.fetchImpl(`${this.baseUrl}/r/${room}?format=json&since=${since}&limit=200`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`read ${room}: ${res.status}`);
    return JSON.parse((await res.text()).replace(/"nonce":\s*(\d+)/g, '"nonce":"$1"'));
  }

  async readTail(room: string): Promise<{ messages: RoomMessage[] }> {
    const res = await this.fetchImpl(`${this.baseUrl}/r/${room}?format=json&limit=200`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`read ${room}: ${res.status}`);
    return JSON.parse((await res.text()).replace(/"nonce":\s*(\d+)/g, '"nonce":"$1"'));
  }

  async readNote(ns: string, key: string): Promise<string | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/kv/${ns}/${key}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read note ${ns}/${key}: ${res.status}`);
    const t = await res.text();
    const i = t.indexOf("\n\n");                       // the plain lane prepends an untrusted-content banner
    return (i >= 0 ? t.slice(i + 2) : t).split("\n")[0].trim() || null;
  }
}
