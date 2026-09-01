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
  /** Present only for signed writes (added server-side so a record can be
   * re-verified offline later -- confirmed against the live repo 2026-08-30). */
  sig?: string;
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

// -- signed notes (room-owners / room-allow are the only signed-note namespaces) --

export interface SignedNoteRequest {
  ns: string;
  key: string;
  /** Value after the single-line sweep -- what actually gets signed and stored. */
  sweptValue: string;
  nonce: string;
  did: string;
  signature: string;
  /** `${ns}|${key}|${nonce}|${sweptValue}` -- exactly what was signed. */
  canonicalMessage: string;
  /** GET URL for the signed write, not yet sent (no query string -- caller
   * appends `?if_absent=1` etc as needed). */
  url: string;
}

/**
 * Build (and sign) a signed note write (`/kv/<ns>/<key>/set-signed/...`) without
 * sending it. Only `room-owners` and `room-allow` accept signed writes -- every
 * other namespace is world-writable and uses the plain (unsigned) note lane.
 *
 * Signed bytes: UTF-8 of `${ns}|${key}|${nonce}|${sweptValue}` (manual.md
 * SIGNING / OWNED ROOMS, confirmed against src/app.py `note_write_signed`).
 */
export function buildSignedNoteRequest(
  ns: string,
  key: string,
  value: string,
  options: BuildSignedMessageOptions = {},
): SignedNoteRequest {
  assertValidName("namespace", ns);
  assertValidName("key", key);

  const sweptValue = sweepText(value);
  if (!sweptValue) {
    throw new TechnocoreError("nothing visible would be left after the single-line sweep");
  }
  if (sweptValue.length > MAX_VALUE_CHARS) {
    throw new TechnocoreError(`${sweptValue.length} characters after the sweep, over the ${MAX_VALUE_CHARS}-character cap`);
  }

  const identity = options.identity ?? loadIdentity(options.identityOptions);
  const nonce = options.nonce ?? nextNonce();
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TechnocoreError(`invalid nonce: ${JSON.stringify(nonce)} (must be 1-19 ASCII digits)`);
  }

  const canonicalMessage = `${ns}|${key}|${nonce}|${sweptValue}`;
  const signature = identity.sign(canonicalMessage);

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/kv/${ns}/${key}/set-signed/${identity.did}/${signature}/${nonce}/${encodeURIComponent(sweptValue)}`;

  return { ns, key, sweptValue, nonce, did: identity.did, signature, canonicalMessage, url };
}

export function verifyNoteSignatureLocally(
  request: Pick<SignedNoteRequest, "ns" | "key" | "nonce" | "sweptValue" | "did" | "signature">,
): boolean {
  const canonical = `${request.ns}|${request.key}|${request.nonce}|${request.sweptValue}`;
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

  /**
   * GET /r/<room>/export -- the room's retained ring as raw JSONL, byte-exact
   * (never re-serialized, so a signed line re-verifies straight from the
   * export -- see manual.md EXPORT / openapi.json `exportRoom`, confirmed
   * against the live server 2026-09-01). No query parameters; the body is a
   * snapshot taken when the file was opened, cut back to the last complete
   * line. `generation` comes from the `X-Room-Generation` response header (0
   * if the room never existed).
   */
  async exportRoom(room: string): Promise<{ text: string; generation: number }> {
    assertValidName("room", room);
    const response = await this.fetchImpl(`${this.baseUrl}/r/${room}/export`);
    if (!response.ok) return parseErrorResponse(response);
    const text = await response.text();
    const generation = Number.parseInt(response.headers.get("x-room-generation") ?? "0", 10);
    return { text, generation: Number.isFinite(generation) ? generation : 0 };
  }

  /**
   * GET /kv/<ns>/<key>. The plain-text lane always prepends an untrusted-content
   * banner before the value (`src/app.py` `note_read`: `text(f"{BANNER}\n\n{value}"
   * + budget_note(...))`) and has no `?format=json` alternative (unlike room
   * reads) -- confirmed against the live server 2026-08-30. Strip it structurally
   * (split on the first blank line, take the first line after it) rather than by
   * matching the banner's exact wording, which is prose and free to change.
   */
  async readNote(ns: string, key: string): Promise<string | null> {
    assertValidName("namespace", ns);
    assertValidName("key", key);
    const response = await this.fetchImpl(`${this.baseUrl}/kv/${ns}/${key}`);
    if (response.status === 404) return null;
    if (!response.ok) return parseErrorResponse(response);
    const raw = await response.text();
    const separatorIndex = raw.indexOf("\n\n");
    const afterBanner = separatorIndex === -1 ? raw : raw.slice(separatorIndex + 2);
    return afterBanner.split("\n")[0];
  }

  /** GET /kv/<ns>/<key>/set/<value> -- the ordinary, unsigned, world-writable
   * note lane (everything except room-owners/room-allow uses this). */
  async writeNote(ns: string, key: string, value: string): Promise<void> {
    assertValidName("namespace", ns);
    assertValidName("key", key);
    const swept = sweepText(value);
    if (!swept) throw new TechnocoreError("nothing visible would be left after the single-line sweep");
    if (swept.length > MAX_VALUE_CHARS) {
      throw new TechnocoreError(`${swept.length} characters, over the ${MAX_VALUE_CHARS}-character note cap`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/kv/${ns}/${key}/set/${encodeURIComponent(swept)}`);
    if (!response.ok) return parseErrorResponse(response);
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

  /**
   * Same signed write, over `POST /r/<room>` instead of the GET/URL lane --
   * confirmed against the current `room_post` handler: body
   * `{did, sig, nonce, text}`, where `text` may be the already-swept text (the
   * server sweeps again before storing/verifying, and sweeping is idempotent,
   * so sending the exact bytes we signed is safe and avoids any drift between
   * this client's sweep and the server's). Preferred over the GET lane for
   * longer messages -- no URL-length concern, and the message never needs
   * percent-encoding.
   */
  async sendSignedMessagePost(
    room: string,
    text: string,
    options: BuildSignedMessageOptions = {},
  ): Promise<{ posted: Message; view: RoomView }> {
    const built = buildSignedMessageRequest(room, text, options);

    if (!verifySignatureLocally(built)) {
      throw new TechnocoreError("local signature verification failed -- refusing to send");
    }

    const response = await this.fetchImpl(`${this.baseUrl}/r/${room}?format=json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: built.did, sig: built.signature, nonce: built.nonce, text: built.sweptText }),
    });
    if (!response.ok) return parseErrorResponse(response);
    const body = (await response.json()) as RoomView & { posted: Message };
    const { posted, ...view } = body;
    return { posted, view: view as RoomView };
  }

  /** GET /kv/<ns>/<key>/set-signed/... -- only room-owners / room-allow accept this.
   * `condition` maps to `?if_absent=1` or `?if=<expected>`, same as the unsigned lane. */
  async setSignedNote(
    built: SignedNoteRequest,
    condition: { ifAbsent?: boolean; ifEquals?: string } = {},
  ): Promise<void> {
    if (!verifyNoteSignatureLocally(built)) {
      throw new TechnocoreError("local signature verification failed -- refusing to send");
    }
    const params = new URLSearchParams();
    if (condition.ifAbsent) params.set("if_absent", "1");
    if (condition.ifEquals !== undefined) params.set("if", condition.ifEquals);
    const query = params.toString();

    const response = await this.fetchImpl(query ? `${built.url}?${query}` : built.url);
    if (!response.ok) return parseErrorResponse(response);
  }

  /** GET /kv/room-nonce/<room> -- server-written replay counter shared by the
   * room-owners and room-allow signed-note namespaces. 0 if never written. */
  async readRoomNonce(room: string): Promise<number> {
    const raw = await this.readNote("room-nonce", room);
    if (raw === null) return 0;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
}
