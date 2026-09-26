/**
 * Write journal: at-least-once delivery + idempotent resolution for every future
 * network write. Transport-agnostic (the live HTTP transport is in live/, tests use
 * a mock server), so the recovery logic is exercised without any real write.
 *
 * Per operation (op_key is the idempotency key, e.g. `owner:CC002`, `room:d-x`,
 * `trade:<trade_id>`, `note:room-allow:d-x:<value sha>`):
 *
 *   PLANNED    persisted before anything else (nothing signed yet)
 *   PREPARED   nonce reserved + body signed + body persisted, in ONE transaction
 *   SENDING    persisted immediately before the HTTP request
 *   CONFIRMED  2xx and the response persisted, or found by read-back
 *   UNKNOWN    timeout / network error / crash while SENDING: never retried blindly
 *   FAILED     definitive refusal that is not a duplicate (e.g. 403 not allowed)
 *
 * Recovery (on every start, and for UNKNOWN rows each tick):
 *   PLANNED  -> prepare and send;  PREPARED -> send the SAME persisted body;
 *   SENDING/UNKNOWN -> read back first: messages by our DID in that room with the same
 *   text (or the note holding our value), and only if absent resend the SAME body.
 *   A resend of the same body cannot duplicate a message: the server refuses a nonce
 *   that is not greater than the key's last one. A nonce refusal with our text absent
 *   means our nonce is behind the server's: reserve past the server's last nonce and
 *   re-sign the same text. Anything still ambiguous after `maxResolveTries` halts
 *   execution (ambiguous_operation) -- it never guesses.
 *
 * Trades are doubly safe: the referee settles a trade id at most once, so even a
 * duplicated trade message can never create a second position.
 */

import { randomBytes } from "node:crypto";
import { ccLog } from "./logger.js";
import { buildSignedMessage, buildSignedNote, sha256Hex, sweepText, type Signer } from "./protocol-writes.js";
import { now, type CcDb } from "./store.js";
import { WriterDisarmed } from "./safety.js";

export type OpKind = "owner" | "room" | "trade" | "keepalive" | "note-owners" | "note-allow";
export type AttemptState = "PLANNED" | "PREPARED" | "SENDING" | "CONFIRMED" | "UNKNOWN" | "FAILED";

export interface WriteOp {
  opKey: string;
  kind: OpKind;
  signerId: string;
  room: string;                 // message room, or the d- room a note belongs to
  text?: string;                // messages
  value?: string;               // notes
  ifAbsent?: boolean;           // notes (the initial claim)
  ifValue?: string;             // notes: compare-and-set against the value read just before
}

export class TransportTimeout extends Error {}

export interface TransportResponse { status: number; text: string }
/**
 * technocore.chat reads go through Cloudflare (`s-maxage=5, stale-while-revalidate=25`): a read right after a write
 * can return the value from up to ~30 s before. Every read-back must see the origin, so each GET carries a unique
 * query parameter (a cache MISS; technocore ignores unknown parameters). 26 Sep: a stale read of room-allow right
 * after rewriting it halted the bootstrap with a false room_ownership.
 */
let freshSeq = 0;
export function fresh(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}fresh=${Date.now().toString(36)}${(++freshSeq).toString(36)}`;
}

export interface RoomMessage { seq: number; from: string; text: string; nonce?: string; ts?: string }

export interface Transport {
  post(path: string, body: unknown): Promise<TransportResponse>;
  readRoom(room: string, since: number): Promise<{ first_seq: number | null; last_seq: number; messages: RoomMessage[]; generation?: number }>;
  readNote(ns: string, key: string): Promise<string | null>;
  /** The newest messages (GET /r/<room>?limit=200): a fresh write is found here even in a busy room. */
  readTail?(room: string): Promise<{ messages: RoomMessage[]; generation?: number; last_seq?: number }>;
}

export interface AttemptRow {
  attempt_id: string; op_key: string; kind: OpKind; room: string | null; ns: string | null; note_key: string | null;
  signer_id: string; nonce: string; payload_sha256: string; body: string; state: AttemptState; http_status: number | null;
  response: string | null; error: string | null; tries: number; receipt?: string | null;
}

export class AmbiguousOperation extends Error {}

/**
 * Keep the server's own receipt of OUR record (the POST reply is the room after the append, with
 * ?format=json): status, seq, ts, generation -- so the audit trail survives technocore's ring.
 */
function receiptOf(res: TransportResponse, body: { nonce: string; did: string; text?: string; value?: string }): string {
  const base: Record<string, unknown> = { status: res.status, at: new Date().toISOString() };
  try {
    const v = JSON.parse(res.text.replace(/"nonce":\s*(\d+)/g, '"nonce":"$1"')) as { generation?: number; messages?: RoomMessage[] };
    const m = v.messages?.find((x) => x.from === body.did && x.nonce === body.nonce);
    if (m) Object.assign(base, { seq: m.seq, ts: m.ts, generation: v.generation ?? null });
  } catch { base.text = res.text.slice(0, 200); }
  return JSON.stringify(base);
}

/** Seconds to wait from a 429 body ("... retry in 2 s" / "Retry-After: 2"); 5 when unreadable. */
export function retryAfterS(body: string): number {
  const m = body.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i) ?? body.match(/retry-after:?\s*(\d+)/i);
  return m ? Math.min(60, Math.max(1, Number(m[1]))) : 5;
}

const FINAL: AttemptState[] = ["CONFIRMED", "FAILED"];

export class WriteJournal {
  constructor(
    private db: CcDb,
    private signers: Map<string, Signer>,
    private transport: Transport,
    private opts: { maxResolveTries?: number; clock?: () => number; onAmbiguous?: (row: AttemptRow, why: string) => void;
      /** Live kill switch: a non-null reason blocks every send (nothing leaves, nothing changes state). */
      canWrite?: () => string | null } = {},
  ) {}

  private clock(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private scope(op: Pick<WriteOp, "kind" | "room">): string {
    return op.kind === "note-owners" || op.kind === "note-allow" ? `note:${op.room}` : `room:${op.room}`;
  }

  /** Reserve a nonce strictly greater than every nonce this signer used in this scope and than `floor`. */
  reserveNonce(signerId: string, scope: string, floor = 0n): string {
    const row = this.db.prepare("SELECT last_nonce FROM nonces WHERE signer_id = ? AND scope = ?").get(signerId, scope) as { last_nonce: string } | undefined;
    const last = row ? BigInt(row.last_nonce) : 0n;
    let next = BigInt(this.clock());
    if (next <= last) next = last + 1n;
    if (next <= floor) next = floor + 1n;
    this.db.prepare(`INSERT INTO nonces (signer_id, scope, last_nonce, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(signer_id, scope) DO UPDATE SET last_nonce = excluded.last_nonce, updated_at = excluded.updated_at`)
      .run(signerId, scope, next.toString(), now());
    return next.toString();
  }

  get(opKey: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM write_attempts WHERE op_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(opKey) as AttemptRow | undefined;
  }

  pending(): AttemptRow[] {
    return this.db.prepare("SELECT * FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED') ORDER BY created_at, rowid").all() as AttemptRow[];
  }

  /** Idempotent: an op_key that is already planned, in flight or confirmed is returned as is. */
  plan(op: WriteOp): AttemptRow {
    const existing = this.get(op.opKey);
    if (existing && existing.state !== "FAILED") return existing;
    const id = randomBytes(8).toString("hex");
    const isNote = op.kind === "note-owners" || op.kind === "note-allow";
    const body = JSON.stringify({ op });
    this.db.prepare(`INSERT INTO write_attempts (attempt_id, op_key, kind, room, ns, note_key, signer_id, nonce, payload_sha256, body, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'PLANNED', ?, ?)`).run(id, op.opKey, op.kind, isNote ? null : op.room,
      isNote ? (op.kind === "note-owners" ? "room-owners" : "room-allow") : null, isNote ? op.room : null, op.signerId,
      sha256Hex(isNote ? sweepText(op.value ?? "") : sweepText(op.text ?? "")), body, now(), now());
    return this.get(op.opKey)!;
  }

  private opOf(row: AttemptRow): WriteOp {
    return (JSON.parse(row.body) as { op: WriteOp }).op;
  }

  private set(row: AttemptRow, patch: Partial<AttemptRow>): AttemptRow {
    const cols = Object.keys(patch);
    this.db.prepare(`UPDATE write_attempts SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE attempt_id = ?`)
      .run(...cols.map((c) => (patch as Record<string, unknown>)[c] as never), now(), row.attempt_id);
    return this.db.prepare("SELECT * FROM write_attempts WHERE attempt_id = ?").get(row.attempt_id) as AttemptRow;
  }

  /** PLANNED -> PREPARED: reserve the nonce and persist the signed request in one transaction. */
  prepare(row: AttemptRow, nonceFloor = 0n): AttemptRow {
    const op = this.opOf(row);
    const signer = this.signers.get(op.signerId);
    if (!signer) throw new Error(`no signer loaded for ${op.signerId}`);
    return this.db.transaction(() => {
      const nonce = this.reserveNonce(op.signerId, this.scope(op), nonceFloor);
      const req = op.kind === "note-owners" || op.kind === "note-allow"
        ? buildSignedNote(signer, op.kind === "note-owners" ? "room-owners" : "room-allow", op.room, nonce, op.value!, { ifAbsent: op.ifAbsent, ifValue: op.ifValue })
        : buildSignedMessage(signer, op.room, nonce, op.text!);
      return this.set(row, { state: "PREPARED", nonce, body: JSON.stringify({ op, request: req }) });
    })();
  }

  private request(row: AttemptRow): { path: string; body: { nonce: string; text?: string; value?: string; did: string } } {
    return (JSON.parse(row.body) as { request: { path: string; body: { nonce: string; text?: string; value?: string; did: string } } }).request;
  }

  /**
   * Send the persisted request exactly as signed. With `noResend` (live trades) a refusal is final
   * (FAILED) and nothing is ever re-sent: the caller reconciles with readBackOnly().
   */
  async send(row: AttemptRow, opts: { noResend?: boolean } = {}): Promise<AttemptRow> {
    if (row.state === "PLANNED") row = this.prepare(row);
    const blocked = this.opts.canWrite?.() ?? null;
    if (blocked) throw new WriterDisarmed(`writer disarmed: ${blocked}`);
    const req = this.request(row);
    row = this.set(row, { state: "SENDING", tries: row.tries + 1 });
    let res: TransportResponse;
    try {
      res = await this.transport.post(req.path, req.body);
    } catch (e) {
      // A simulated kill -9 must leave the row exactly as a real one would: SENDING, the process gone.
      if ((e as Error).name === "SimulatedKill") throw e;
      ccLog("EXECUTOR", { op: row.op_key, attempt: row.attempt_id, error: (e as Error).message }, "write outcome unknown: will resolve by read-back, never by a blind resend");
      return this.set(row, { state: "UNKNOWN", error: (e as Error).message });
    }
    if (res.status >= 200 && res.status < 300) {
      return this.set(row, { state: "CONFIRMED", http_status: res.status, response: res.text.slice(0, 2000), receipt: receiptOf(res, req.body) } as Partial<AttemptRow>);
    }
    if (res.status === 429) {
      // Rate limited: NOT stored. The same signed body may be sent again after the wait (callers decide when).
      ccLog("EXECUTOR", { op: row.op_key, retry_after_s: retryAfterS(res.text) }, "429: not stored; same body kept for a later send");
      return this.set(row, { state: "PREPARED", http_status: 429, response: res.text.slice(0, 500), error: `429 retry after ${retryAfterS(res.text)} s` });
    }
    if (res.status >= 500) {
      // 5xx: the fate is uncertain (the edge may or may not have reached the origin) -> UNKNOWN, resolved by read-back.
      ccLog("EXECUTOR", { op: row.op_key, status: res.status }, "5xx: outcome uncertain; resolved by read-back, never assumed");
      return this.set(row, { state: "UNKNOWN", http_status: res.status, response: res.text.slice(0, 500), error: `HTTP ${res.status}` });
    }
    if (opts.noResend) {
      ccLog("EXECUTOR", { op: row.op_key, status: res.status, body: res.text.slice(0, 200) }, "write refused (no automatic re-send)");
      return this.set(row, { state: "FAILED", http_status: res.status, response: res.text.slice(0, 2000), error: `HTTP ${res.status}` });
    }
    return this.onRefusal(row, res);
  }

  /** Reconcile an UNKNOWN / SENDING row by reading the server only. Never sends anything. */
  async readBackOnly(row: AttemptRow): Promise<AttemptRow> {
    try {
      const seen = await this.present(row);
      if (seen.present) return this.set(row, { state: "CONFIRMED", error: "found by read-back" });
      return this.set(row, { state: "UNKNOWN", error: "not found by read-back (not re-sent)" });
    } catch (e) {
      return this.set(row, { state: "UNKNOWN", error: `read-back failed: ${(e as Error).message}` });
    }
  }

  private async onRefusal(row: AttemptRow, res: TransportResponse): Promise<AttemptRow> {
    row = this.set(row, { http_status: res.status, response: res.text.slice(0, 2000) });
    // Duplicate text, stale nonce or a 409: the write may already be there. Read back before deciding.
    if (res.status === 409 || res.status === 422 || /nonce|duplicate|already/i.test(res.text)) return this.resolve(row);
    ccLog("EXECUTOR", { op: row.op_key, status: res.status, body: res.text.slice(0, 200) }, "write refused");
    return this.set(row, { state: "FAILED", error: `HTTP ${res.status}` });
  }

  /** Is our persisted request visible on the server? */
  async present(row: AttemptRow): Promise<{ present: boolean; serverNonce: bigint }> {
    const op = this.opOf(row);
    const req = this.request(row);
    if (op.kind === "note-owners" || op.kind === "note-allow") {
      const value = await this.transport.readNote(op.kind === "note-owners" ? "room-owners" : "room-allow", op.room);
      const counter = await this.transport.readNote("room-nonce", op.room);
      return { present: value !== null && value === req.body.value && !!counter && BigInt(counter) >= BigInt(req.body.nonce), serverNonce: counter ? BigInt(counter) : 0n };
    }
    const mine = await this.readMine(op.room, req.body.did, req.body.text);
    const serverNonce = mine.reduce((mx, m) => (m.nonce && BigInt(m.nonce) > mx ? BigInt(m.nonce) : mx), 0n);
    return { present: mine.some((m) => m.text === req.body.text), serverNonce };
  }

  /** Every message by `did` still in the room's history, paging forward (busy rooms like close1 hold thousands). */
  private async readMine(room: string, did: string, text?: string, maxPages = 100): Promise<RoomMessage[]> {
    if (this.transport.readTail) {
      const tail = (await this.transport.readTail(room)).messages.filter((m) => m.from === did);
      if (text !== undefined && tail.some((m) => m.text === text)) return tail;
    }
    const mine: RoomMessage[] = [];
    let since = 0;
    for (let page = 0; page < maxPages; page++) {
      const view = await this.transport.readRoom(room, since);
      mine.push(...view.messages.filter((m) => m.from === did));
      if (!view.messages.length || view.messages.length < 200) return mine;
      since = view.messages[view.messages.length - 1].seq;
    }
    throw new Error(`read-back of ${room} did not reach the end in ${maxPages} pages`);
  }

  /** Where a CONFIRMED message landed: its seq and server timestamp (needed as mint evidence). */
  async locate(row: AttemptRow): Promise<RoomMessage | null> {
    const op = this.opOf(row);
    if (op.kind === "note-owners" || op.kind === "note-allow") return null;
    const req = this.request(row);
    const mine = (await this.readMine(op.room, req.body.did, req.body.text)).filter((m) => m.text === req.body.text);
    // Same text can appear more than once (a deliberate repost): the nonce identifies THIS attempt.
    return mine.find((m) => m.nonce === req.body.nonce) ?? (mine.length === 1 ? mine[0] : null);
  }

  /** Resolve an UNKNOWN / SENDING / refused row without ever creating a duplicate. */
  async resolve(row: AttemptRow): Promise<AttemptRow> {
    const max = this.opts.maxResolveTries ?? 3;
    for (let i = 0; i < max; i++) {
      let seen: { present: boolean; serverNonce: bigint };
      try {
        seen = await this.present(row);
      } catch (e) {
        row = this.set(row, { error: `read-back failed: ${(e as Error).message}` });
        continue;
      }
      if (seen.present) {
        ccLog("EXECUTOR", { op: row.op_key, attempt: row.attempt_id }, "found on the server by read-back: CONFIRMED (no resend)");
        return this.set(row, { state: "CONFIRMED" });
      }
      const req = this.request(row);
      if (seen.serverNonce >= BigInt(req.body.nonce)) {
        // Our text is absent and the server has moved past our nonce: re-sign the same content above it.
        ccLog("EXECUTOR", { op: row.op_key, ours: req.body.nonce, server: seen.serverNonce.toString() }, "nonce behind the server: re-signing the same content with a higher nonce");
        row = this.prepare(this.set(row, { state: "PLANNED" }), seen.serverNonce);
      }
      row = await this.send(row);
      if (FINAL.includes(row.state)) return row;
    }
    const why = `still ambiguous after ${max} read-back/resend rounds`;
    this.opts.onAmbiguous?.(row, why);
    throw new AmbiguousOperation(`${row.op_key}: ${why}`);
  }

  /** Run on start: finish or resolve everything that was in flight when the process stopped. */
  async recover(): Promise<AttemptRow[]> {
    const out: AttemptRow[] = [];
    for (const row of this.pending()) {
      ccLog("EXECUTOR", { op: row.op_key, state: row.state }, "recovering an unfinished write");
      if (row.state === "PLANNED" || row.state === "PREPARED") out.push(await this.send(row));
      else out.push(await this.resolve(row));
    }
    return out;
  }

  async execute(op: WriteOp): Promise<AttemptRow> {
    const row = this.plan(op);
    if (FINAL.includes(row.state)) return row;
    if (row.state === "SENDING" || row.state === "UNKNOWN") return this.resolve(row);
    return this.send(row);
  }
}
