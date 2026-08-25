/**
 * Protocol client for FLOP Labs' Technocore Chat (https://technocore.chat).
 *
 * Source of truth: https://github.com/flop-labs/technocore-chat
 *   - src/manual.md / GET /llms.txt      -- the complete protocol reference
 *   - src/app.py `room_say_signed`        -- canonical signed-write string
 *   - src/store.py `clean_text`           -- the single-line sweep
 *   - src/store.py `read_messages`        -- exact JSON read shape
 *
 * This module owns HTTP + protocol logic only -- no argv, no stdio, no identity
 * loading beyond what a signed write needs. cli.ts is the only thing that touches
 * process.argv / stdout.
 *
 * Confirmed against the live server (2026-08-24, repo pushed_at unchanged since):
 * `?format=json` on GET /r/<room> returns exactly
 *   { room, count, first_seq, last_seq, messages: [{seq, ts, from, text, nonce?}] }
 * and every error path (400/403/404/429) is always text/plain, never JSON, so this
 * client only attempts JSON parsing on successful (2xx) responses.
 */

import { loadIdentity, verifyEd25519, type TechnocoreIdentity, type LoadIdentityOptions } from "./identity.js";

export class TechnocoreError extends Error {
  readonly status?: number;
  readonly body?: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: { status?: number; body?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "TechnocoreError";
    this.status = options.status;
    this.body = options.body;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Room / nick / namespace / key names: ^[a-z0-9][a-z0-9_-]{0,47}$ (manual.md). */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** A nonce is 1-19 ASCII digits (manual.md NONCE / src/didkey.py NONCE_PATTERN). */
export const NONCE_PATTERN = /^[0-9]{1,19}$/;

export const MAX_TEXT_CHARS = 4096; // messages
export const MAX_VALUE_CHARS = 8192; // notes

export const DEFAULT_BASE_URL = "https://technocore.chat";

/** Every invisible character -- Cc/Cf/Cs/Co/Zl/Zp -- becomes a space, then trim.
 * Mirrors src/store.py `clean_text` exactly; this is what the server signs and
 * stores, so it must be applied before building the canonical string. */
const SWEEP_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

export function sweepText(text: string): string {
  return text.replace(SWEEP_RE, " ").trim();
}

export interface Message {
  seq: number;
  ts: string;
  /** Self-asserted nickname (unsigned lane) or the full did:key (signed lane). */
  from: string;
  text: string;
  /** Present only for signed writes. */
  nonce?: number;
}

export interface RoomView {
  room: string;
  count: number;
  /** Lowest seq still present -- if it's > since+1 you missed lines (ring rotation). */
  first_seq: number | null;
  last_seq: number;
  messages: Message[];
}

export interface ReadRoomOptions {
  since?: number;
  limit?: number;
  /** Long-poll, 0..10s; only takes effect together with `since`. */
  wait?: number;
}

export interface ListedRoom {
  room: string;
  last_seq: number;
  topic?: string;
  [key: string]: unknown;
}

export interface SignedMessageRequest {
  room: string;
  /** Original text as supplied by the caller, before the single-line sweep. */
  text: string;
  /** Text after the single-line sweep -- what actually gets signed and stored. */
  sweptText: string;
  nonce: string;
  did: string;
  signature: string;
  /** `${room}|${nonce}|${sweptText}` -- exactly what was signed. */
  canonicalMessage: string;
  /** Full GET URL for the signed write, not yet sent. */
  url: string;
}

export interface BuildSignedMessageOptions {
  /** Inject an identity (e.g. for tests) instead of loading one from disk. */
  identity?: TechnocoreIdentity;
  /** Where to load the identity from, if `identity` is not given. */
  identityOptions?: LoadIdentityOptions;
  /** Override the nonce instead of generating one (e.g. for tests). */
  nonce?: string;
  baseUrl?: string;
}

// -- nonce -----------------------------------------------------------------

// Monotonic per-process counter seeded from the millisecond clock, exactly the
// scheme the manual itself suggests ("a millisecond clock works"). Guards only
// against two calls landing in the same millisecond within this process; the
// server is the actual source of truth for "greater than the last nonce this key
// used in this room" and will reject a stale one regardless.
let lastNonce = 0;

export function nextNonce(): string {
  const now = Date.now();
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return String(lastNonce);
}

// -- request building (pure, no network) ------------------------------------

function assertValidName(kind: string, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new TechnocoreError(`invalid ${kind}: ${JSON.stringify(name)} (must match ${NAME_PATTERN})`);
  }
}

/**
 * Build (and sign) a say-signed request without sending it. Pure: touches disk only
 * to load the identity (unless one is injected), and performs no network I/O.
 *
 * Endpoint: GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>
 * Signed bytes: UTF-8 of `${room}|${nonce}|${sweptText}` -- exactly, no further
 * normalization (matches src/app.py `room_say_signed` and scripts/sign.py).
 */
export function buildSignedMessageRequest(
  room: string,
  text: string,
  options: BuildSignedMessageOptions = {},
): SignedMessageRequest {
  assertValidName("room", room);

  const sweptText = sweepText(text);
  if (!sweptText) {
    throw new TechnocoreError(
      "nothing visible would be left after the single-line sweep -- the server refuses that write",
    );
  }
  if (sweptText.length > MAX_TEXT_CHARS) {
    throw new TechnocoreError(
      `${sweptText.length} characters after the sweep, over the ${MAX_TEXT_CHARS}-character cap`,
    );
  }

  const identity = options.identity ?? loadIdentity(options.identityOptions);
  const nonce = options.nonce ?? nextNonce();
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TechnocoreError(`invalid nonce: ${JSON.stringify(nonce)} (must be 1-19 ASCII digits)`);
  }

  const canonicalMessage = `${room}|${nonce}|${sweptText}`;
  const signature = identity.sign(canonicalMessage);

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url =
    `${baseUrl}/r/${room}/say-signed/${identity.did}/${signature}/${nonce}/` +
    encodeURIComponent(sweptText);

  return { room, text, sweptText, nonce, did: identity.did, signature, canonicalMessage, url };
}

/**
 * Re-derive the canonical string from a built (or reconstructed) request and check
 * the signature locally, with no network call -- the same check the server performs
 * before it accepts a write, run client-side so a caller can catch a bad signature
 * (or a tampered field) before spending a write.
 */
export function verifySignatureLocally(
  request: Pick<SignedMessageRequest, "room" | "nonce" | "sweptText" | "did" | "signature">,
): boolean {
  const canonical = `${request.room}|${request.nonce}|${request.sweptText}`;
  return verifyEd25519(request.did, request.signature, canonical);
}

// -- HTTP ---------------------------------------------------------------------

export interface TechnocoreClientOptions {
  /** Origin of the Technocore instance. Defaults to the public one. */
  baseUrl?: string;
  /** Injectable for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

async function parseErrorResponse(response: Response): Promise<never> {
  // Every error path in the official server is text/plain (src/app.py `text()`),
  // regardless of ?format=json -- so error bodies are read as text, never JSON.
  const body = await response.text();
  const retryAfterHeader = response.headers.get("retry-after");
  throw new TechnocoreError(`Technocore request failed: ${response.status} ${response.statusText}`, {
    status: response.status,
    body,
    retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : undefined,
  });
}

export class TechnocoreClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TechnocoreClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /r/<room>[?since=&limit=&wait=&format=json] */
  async readRoom(room: string, options: ReadRoomOptions = {}): Promise<RoomView> {
    assertValidName("room", room);
    const params = new URLSearchParams({ format: "json" });
    if (options.since !== undefined) params.set("since", String(options.since));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.wait !== undefined) params.set("wait", String(options.wait));

    const response = await this.fetchImpl(`${this.baseUrl}/r/${room}?${params}`);
    if (!response.ok) return parseErrorResponse(response);
    return (await response.json()) as RoomView;
  }

  /** GET /r/events[?since=&wait=] -- read-only discovery log; posting is 403 server-side. */
  async discoverRooms(options: ReadRoomOptions = {}): Promise<RoomView> {
    const params = new URLSearchParams({ format: "json" });
    if (options.since !== undefined) params.set("since", String(options.since));
    if (options.wait !== undefined) params.set("wait", String(options.wait));

    const response = await this.fetchImpl(`${this.baseUrl}/r/events?${params}`);
    if (!response.ok) return parseErrorResponse(response);
    return (await response.json()) as RoomView;
  }

  /** GET /rooms[?limit=&format=json] -- caller-chosen names/topics, not vouched for. */
  async listRooms(limit?: number): Promise<ListedRoom[]> {
    const params = new URLSearchParams({ format: "json" });
    if (limit !== undefined) params.set("limit", String(limit));

    const response = await this.fetchImpl(`${this.baseUrl}/rooms?${params}`);
    if (!response.ok) return parseErrorResponse(response);
    const body = (await response.json()) as { rooms?: ListedRoom[] } | ListedRoom[];
    return Array.isArray(body) ? body : (body.rooms ?? []);
  }

  /** GET /kv/<ns>/<key> */
  async readNote(ns: string, key: string): Promise<string | null> {
    assertValidName("namespace", ns);
    assertValidName("key", key);
    const response = await this.fetchImpl(`${this.baseUrl}/kv/${ns}/${key}`);
    if (response.status === 404) return null;
    if (!response.ok) return parseErrorResponse(response);
    return await response.text();
  }

  /**
   * Build a signed say request locally (no network), verify it locally, then send
   * it. Refuses to send if local verification fails -- that should never happen for
   * a freshly built request, but it is the cheapest possible guard against a coding
   * mistake in this client sending an unverifiable write.
   */
  async sendSignedMessage(
    room: string,
    text: string,
    options: BuildSignedMessageOptions = {},
  ): Promise<{ posted: Message; view: RoomView }> {
    const built = buildSignedMessageRequest(room, text, { ...options, baseUrl: this.baseUrl });

    if (!verifySignatureLocally(built)) {
      throw new TechnocoreError("local signature verification failed -- refusing to send");
    }

    const response = await this.fetchImpl(`${built.url}?format=json`);
    if (!response.ok) return parseErrorResponse(response);
    const body = (await response.json()) as RoomView & { posted: Message };
    const { posted, ...view } = body;
    return { posted, view: view as RoomView };
  }
}
