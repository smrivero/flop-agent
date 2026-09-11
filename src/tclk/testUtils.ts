/**
 * An in-memory fake of just enough of the real Technocore HTTP surface
 * (`GET /r/<room>`, `GET /r/<room>/say-signed/...`, `POST /r/<room>`,
 * `GET /kv/<ns>/<key>[/set/<value>]`) for `TechnocoreClient` -- the REAL,
 * unmodified client -- to run against in tests, end to end, with zero network
 * calls. This lets tclk's own tests exercise the exact same code path
 * production uses (readRoom, sendSignedMessage, readNote, writeNote with
 * CAS), including local signature re-verification on read, rather than
 * stubbing tclk's own functions.
 *
 * Deliberately mirrors what the real server would do, including rejecting a
 * badly-signed `say-signed`/`POST` write (400) -- but `inject(...)` bypasses
 * that path entirely, for tests that need to plant a message the real server
 * would never have accepted (spoofed `from`, garbage `sig`, unsigned), to
 * prove the *reader* (transcript.ts) rejects it independently.
 */

import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { didFromPublicKey, verifyEd25519, type TechnocoreIdentity } from "../identity.js";
import { sweepText, type Message } from "../technocore.js";

/** A fresh, throwaway Ed25519 did:key identity for tests -- never touches disk. */
export function makeTestIdentity(): TechnocoreIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const did = didFromPublicKey(publicKeyBytes);
  return { did, sign: (message: string) => ed25519Sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url") };
}

interface FakeRoom {
  messages: Message[];
  nextSeq: number;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class FakeTechnocore {
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly notes = new Map<string, string>();

  private room(name: string): FakeRoom {
    let room = this.rooms.get(name);
    if (!room) {
      room = { messages: [], nextSeq: 1 };
      this.rooms.set(name, room);
    }
    return room;
  }

  /** Directly append a message, bypassing signature verification entirely --
   * for planting hostile/malformed content a real writer could never post
   * through the signed lane. */
  inject(roomName: string, message: Omit<Message, "seq" | "ts">): Message {
    const room = this.room(roomName);
    const full: Message = { seq: room.nextSeq++, ts: new Date().toISOString(), ...message };
    room.messages.push(full);
    return full;
  }

  /** Test-only: simulate the venue's ring-buffer retention rotating past
   * older messages -- drops every stored message with `seq < keepFromSeq` so
   * a subsequent read's `first_seq` reflects a real ring rotation, letting
   * tests exercise gap-detection logic without waiting for real volume. */
  evictBefore(roomName: string, keepFromSeq: number): void {
    const room = this.room(roomName);
    room.messages = room.messages.filter((m) => m.seq >= keepFromSeq);
  }

  /** Post as a real identity would: sign locally, then feed it through the
   * same acceptance check the fake server enforces on a real request. */
  postSigned(roomName: string, identity: TechnocoreIdentity, text: string): Message {
    const swept = sweepText(text);
    const nonce = String(Date.now() + Math.floor(Math.random() * 1_000_000));
    const canonical = `${roomName}|${nonce}|${swept}`;
    const sig = identity.sign(canonical);
    return this.inject(roomName, { from: identity.did, text: swept, nonce: Number(nonce), sig });
  }

  /** `TechnocoreClientOptions.fetchImpl` -- pass a `FakeTechnocore` instance's
   * `.fetch` directly as `fetchImpl`. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const parts = url.pathname.split("/").filter(Boolean);

    if (init?.method === "POST" && parts[0] === "r" && parts.length === 2) {
      const body = JSON.parse(String(init.body)) as { did: string; sig: string; nonce: string; text: string };
      const roomName = decodeURIComponent(parts[1]);
      const swept = sweepText(body.text);
      const canonical = `${roomName}|${body.nonce}|${swept}`;
      if (!verifyEd25519(body.did, body.sig, canonical)) return new Response("400 bad signature", { status: 400 });
      const posted = this.inject(roomName, { from: body.did, text: swept, nonce: Number(body.nonce), sig: body.sig });
      const room = this.room(roomName);
      return json({ room: roomName, count: room.messages.length, first_seq: room.messages[0]?.seq ?? null, last_seq: room.nextSeq - 1, messages: room.messages, posted });
    }

    // GET /r/<room>/export -- raw JSONL, one record per line, the whole
    // retained (fake) ring. Added for sonnet/room-export.ts's tests; every
    // other handler below is unchanged.
    if (parts[0] === "r" && parts[2] === "export" && parts.length === 3) {
      const room = this.room(decodeURIComponent(parts[1]));
      const body = room.messages.map((m) => JSON.stringify(m)).join("\n");
      return new Response(body, { status: 200, headers: { "X-Room-Generation": "0" } });
    }

    // GET /r/<room>?since=&format=json
    if (parts[0] === "r" && parts.length === 2) {
      const room = this.room(decodeURIComponent(parts[1]));
      const since = Number(url.searchParams.get("since") ?? "0");
      const messages = room.messages.filter((m) => m.seq > since);
      return json({ room: parts[1], count: messages.length, first_seq: room.messages[0]?.seq ?? null, last_seq: room.nextSeq - 1, messages });
    }

    // GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>?format=json
    if (parts[0] === "r" && parts[2] === "say-signed") {
      const roomName = decodeURIComponent(parts[1]);
      const [did, sig, nonce, encodedText] = parts.slice(3);
      const text = decodeURIComponent(encodedText);
      const swept = sweepText(text);
      const canonical = `${roomName}|${nonce}|${swept}`;
      if (!verifyEd25519(did, sig, canonical)) return new Response("400 bad signature", { status: 400 });
      const posted = this.inject(roomName, { from: did, text: swept, nonce: Number(nonce), sig });
      const room = this.room(roomName);
      return json({ room: roomName, count: room.messages.length, first_seq: room.messages[0]?.seq ?? null, last_seq: room.nextSeq - 1, messages: room.messages, posted });
    }

    // GET /kv/<ns>/<key>
    if (parts[0] === "kv" && parts.length === 3) {
      const key = `${parts[1]}/${parts[2]}`;
      const value = this.notes.get(key);
      if (value === undefined) return new Response("404", { status: 404 });
      return new Response(value, { status: 200 });
    }

    // GET /kv/<ns>/<key>/set/<value>[?if_absent=1|?if=<expected>]
    if (parts[0] === "kv" && parts[3] === "set") {
      const key = `${parts[1]}/${parts[2]}`;
      const value = decodeURIComponent(parts[4]);
      const ifAbsent = url.searchParams.get("if_absent") === "1";
      const ifEquals = url.searchParams.get("if");
      const current = this.notes.get(key);
      if (ifAbsent && current !== undefined) return new Response("409 already present", { status: 409 });
      if (ifEquals !== null && current !== ifEquals) return new Response("409 changed under us", { status: 409 });
      this.notes.set(key, value);
      return json({ ns: parts[1], key: parts[2] });
    }

    return new Response("404 not found in fake technocore", { status: 404 });
  };
}
