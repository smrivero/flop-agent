/**
 * In-memory technocore.chat for tests (never used at runtime). It enforces the rules
 * of the real server's source (technocore-chat src/app.py, src/store.py) that our
 * writes depend on:
 *   - Ed25519 signatures over `<room>|<nonce>|<text>` / `<ns>|<key>|<nonce>|<value>`
 *   - message nonce strictly greater than the key's last nonce in that room
 *   - duplicate filter: at most `dupeMax` copies of one text per room per window
 *   - owned d- rooms: only the owner and allow-listed keys may write
 *   - ownership notes: signed, first claim by the stored key and only before the
 *     room's first message, later writes by the current owner, nonce greater than
 *     the shared /kv/room-nonce/<room> counter
 * Fault injection: `failNext("drop")` loses the request before it is stored;
 * `failNext("timeout-after-commit")` stores it and then throws like a client timeout.
 */

import { createPublicKey, verify } from "node:crypto";
import { publicKeyFromDid } from "../../identity.js";
import { sweepText, type SignedMessageBody, type SignedNoteBody } from "../protocol-writes.js";
import { TransportTimeout, type RoomMessage, type Transport, type TransportResponse } from "../journal.js";

type Fault = "drop" | "timeout-after-commit" | "timeout-before-commit" | "429";

export class MockTechnocore implements Transport {
  rooms = new Map<string, RoomMessage[]>();
  notes = new Map<string, string>();
  lastNonce = new Map<string, bigint>();       // `${room}|${did}`
  private recent: { room: string; text: string; at: number }[] = [];
  private faults: Fault[] = [];
  posts = 0;
  clock = () => Date.now();
  constructor(public dupeMax = 5, public dupeWindowMs = 120_000) {}

  failNext(f: Fault): void {
    this.faults.push(f);
  }

  private verifySig(did: string, message: string, sig: string): boolean {
    try {
      const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKeyFromDid(did)]);
      return verify(null, Buffer.from(message, "utf8"), createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(sig, "base64url"));
    } catch {
      return false;
    }
  }

  async post(path: string, body: unknown): Promise<TransportResponse> {
    this.posts++;
    const fault = this.faults.shift();
    if (fault === "drop" || fault === "timeout-before-commit") throw new TransportTimeout("request lost before the server stored it");
    if (fault === "429") return { status: 429, text: "429 write bucket empty: refills 5/s, retry in 1 s" };
    const res = path.startsWith("/kv/") ? this.postNote(path, body as SignedNoteBody) : this.postMessage(path, body as SignedMessageBody);
    if (fault === "timeout-after-commit") throw new TransportTimeout("server stored it but the client timed out");
    return res;
  }

  private postMessage(path: string, b: SignedMessageBody): TransportResponse {
    const room = path.slice(3);
    const text = sweepText(b.text);
    if (!this.verifySig(b.did, `${room}|${b.nonce}|${text}`, b.sig)) return { status: 401, text: "401 signature does not verify" };
    if (room.startsWith("d-") && this.notes.has(`room-owners/${room}`)) {
      const owner = this.notes.get(`room-owners/${room}`)!;
      const allow = (this.notes.get(`room-allow/${room}`) ?? "").split(" ");
      if (b.did !== owner && !allow.includes(b.did)) return { status: 403, text: "403 owned room: writes from the owner or its allow-list only" };
    }
    const k = `${room}|${b.did}`;
    if (BigInt(b.nonce) <= (this.lastNonce.get(k) ?? 0n)) return { status: 409, text: "409 nonce must be greater than the last nonce this key used here" };
    const t = this.clock();
    this.recent = this.recent.filter((r) => t - r.at < this.dupeWindowMs);
    if (text.length > 16 && this.recent.filter((r) => r.room === room && r.text === text).length >= this.dupeMax) {
      return { status: 422, text: "422 duplicate: this room already accepted that text recently" };
    }
    this.recent.push({ room, text, at: t });
    this.lastNonce.set(k, BigInt(b.nonce));
    const msgs = this.rooms.get(room) ?? [];
    const seq = msgs.length + 1;
    msgs.push({ seq, from: b.did, text, nonce: b.nonce, ts: new Date(t).toISOString() });
    this.rooms.set(room, msgs);
    return { status: 200, text: JSON.stringify({ ok: true, seq }) };
  }

  private postNote(path: string, b: SignedNoteBody): TransportResponse {
    const [, , ns, key] = path.split("/");
    if (ns === "room-nonce") return { status: 403, text: "403 /kv/room-nonce is written by the server only" };
    if (ns !== "room-owners" && ns !== "room-allow") return { status: 400, text: "400 signed note writes only for room-owners and room-allow" };
    const value = sweepText(b.value);
    if (!this.verifySig(b.did, `${ns}|${key}|${b.nonce}|${value}`, b.sig)) return { status: 401, text: "401 signature does not verify" };
    const owner = this.notes.get(`room-owners/${key}`);
    if (ns === "room-owners") {
      if (owner !== undefined && b.did !== owner) return { status: 403, text: `403 /r/${key} is already owned` };
      if (owner === undefined && b.did !== value) return { status: 403, text: "403 a first claim must be signed by the key it stores" };
      if (owner === undefined && (this.rooms.get(key)?.length ?? 0) > 0) return { status: 403, text: "403 room already has messages" };
      if (b.if_absent && owner !== undefined) return { status: 409, text: "409 if_absent: note exists" };
    } else if (owner === undefined || b.did !== owner) {
      return { status: 403, text: "403 only the room owner writes room-allow" };
    }
    if (b.if !== undefined && (this.notes.get(`${ns}/${key}`) ?? null) !== b.if) return { status: 409, text: "409 if: the note no longer holds that value" };
    const counter = BigInt(this.notes.get(`room-nonce/${key}`) ?? "0");
    if (BigInt(b.nonce) <= counter) return { status: 409, text: "409 nonce must exceed /kv/room-nonce" };
    this.notes.set(`room-nonce/${key}`, b.nonce);
    this.notes.set(`${ns}/${key}`, value);
    return { status: 200, text: `ok ${ns}/${key}` };
  }

  async readRoom(room: string, since: number) {
    const msgs = (this.rooms.get(room) ?? []).filter((m) => m.seq > since).slice(0, 200);
    return { first_seq: msgs[0]?.seq ?? null, last_seq: this.rooms.get(room)?.length ?? 0, messages: msgs };
  }

  async readTail(room: string) {
    return { messages: (this.rooms.get(room) ?? []).slice(-200) };
  }

  async readNote(ns: string, key: string): Promise<string | null> {
    return this.notes.get(`${ns}/${key}`) ?? null;
  }

  count(room: string, text: string): number {
    return (this.rooms.get(room) ?? []).filter((m) => m.text === text).length;
  }
}
