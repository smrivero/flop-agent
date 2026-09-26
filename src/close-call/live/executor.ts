/**
 * LIVE ONLY. Executes Strategy K intents with real keys. It never decides anything: the intent (pair,
 * favoured side, px, qty, until, trade id) comes unchanged from the shared decision engine (paper.ts).
 *
 * live_trades.state, one row per intent, persisted BEFORE each step:
 *   CREATED     intent received (terms + payload hash stored; trade id fixed forever)
 *   NOT_POSTED  a pre-POST check failed or the deadline passed: nothing was sent
 *   SIGNED      maker + taker signatures over the final terms, both verified; text immutable from here
 *   POSTING     outer message signed with a persisted nonce (write journal), HTTP request in flight
 *   POSTED      2xx from technocore.chat, or found by read-back after an uncertain response
 *   CONFIRMED   located in our room with a stamp before the sweep's boundary
 *   LATE        located, but stamped after the boundary (the referee will void it: expired)
 *   SETTLED / VOID   outcome of the official fold at the referee's own ref/close (referee lists checked apart)
 *   FAILED      refused by the server (nothing stored there)
 *   UNKNOWN     the POST's fate is uncertain and read-back did not find it: execution halts, NO re-send
 *
 * Recovery (start): CREATED/SIGNED before the deadline -> executed normally (same trade id, same signed
 * text); after it -> NOT_POSTED. POSTING -> the journal row decides: PREPARED (never sent) is sent if still
 * before the deadline; SENDING/UNKNOWN is resolved by read-back ONLY (found -> POSTED, else UNKNOWN + halt).
 */

import { verifyEd25519 } from "../../identity.js";
import { sweepTime, type Contest } from "../contest.js";
import { retryAfterS, type AttemptRow, type Transport, type WriteJournal } from "../journal.js";
import { getKey, isTradable } from "../keys.js";
import { ccLog } from "../logger.js";
import type { ExecIntent, ExecResult, TradeExecutor } from "../paper.js";
import { canonicalTerms, makerSigningString, takerSigningString, type Terms } from "../protocol.js";
import { buildSignedTrade, sha256Hex, type Signer } from "../protocol-writes.js";
import { getRoom } from "../room.js";
import { halt } from "../safety.js";
import { now, type CcDb } from "../store.js";

export interface LiveTradeRow {
  intent_id: string; trade_id: string; sweep: number; pair_index: number | null; maker_id: string; taker_id: string; terms: string;
  payload_sha256: string; text: string | null; state: string; attempt_op: string | null; seq: number | null; stamped_at: string | null;
  fold_outcome: string | null; referee_outcome: string | null; detail: string | null;
  decided_at: string | null; sign_start: string | null; sign_end: string | null; post_at: string | null; response_at: string | null;
}

const POSTED_STATES = ["POSTED", "CONFIRMED", "LATE", "SETTLED", "VOID", "NOT_APPLIED"];
const iso = (ms: number) => new Date(ms).toISOString();

export class LiveExecutor implements TradeExecutor {
  readonly live = true;
  private allowCache: { sweep: number; writers: Set<string> } | null = null;

  constructor(
    private db: CcDb,
    private signers: Map<string, Signer>,
    private journal: WriteJournal,
    private transport: Transport,
    private room: string,
    private contest: Contest,
    private guardMs: number,
    private clock: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  has(intentId: string): boolean {
    return !!this.get(intentId);
  }

  get(intentId: string): LiveTradeRow | undefined {
    return this.db.prepare("SELECT * FROM live_trades WHERE intent_id = ?").get(intentId) as LiveTradeRow | undefined;
  }

  private set(intentId: string, patch: Partial<LiveTradeRow>): LiveTradeRow {
    const cols = Object.keys(patch);
    this.db.prepare(`UPDATE live_trades SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE intent_id = ?`)
      .run(...cols.map((c) => (patch as Record<string, unknown>)[c] as never), now(), intentId);
    return this.get(intentId)!;
  }

  private notPosted(i: ExecIntent, detail: string): ExecResult {
    this.set(i.intentId, { state: "NOT_POSTED", detail });
    this.db.prepare("UPDATE intents SET risk_status = 'NOT_SENT', risk_detail = ? WHERE intent_id = ?").run(JSON.stringify({ state: "NOT_POSTED", detail }), i.intentId);
    ccLog("LIVE TRADE", { intent: i.intentId, trade_id: i.terms.id, sweep: i.sweep, state: "NOT_POSTED", detail }, "not posted: nothing was sent");
    return { posted: false, state: "NOT_POSTED", detail };
  }

  /** Writers of our room: owner + allow-list, read from technocore once per sweep. */
  private async writers(sweep: number): Promise<Set<string>> {
    if (this.allowCache?.sweep === sweep) return this.allowCache.writers;
    const owner = await this.transport.readNote("room-owners", this.room);
    const allow = await this.transport.readNote("room-allow", this.room);
    const w = new Set([owner ?? "", ...(allow ?? "").split(/\s+/)].filter(Boolean));
    this.allowCache = { sweep, writers: w };
    return w;
  }

  async post(i: ExecIntent, precheck: () => Promise<string[]>): Promise<ExecResult> {
    let row = this.get(i.intentId);
    if (row && !["CREATED", "SIGNED"].includes(row.state)) {
      return { posted: POSTED_STATES.includes(row.state), state: row.state, detail: "already executed: never posted twice" };
    }
    const payload = canonicalTerms(i.terms);
    if (!row) {
      this.db.prepare(`INSERT INTO live_trades (intent_id, trade_id, sweep, pair_index, maker_id, taker_id, terms, payload_sha256, state, decided_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?)`).run(i.intentId, i.terms.id, i.sweep, i.pairIndex, i.makerId, i.takerId, payload, sha256Hex(payload), iso(i.decidedAtMs), now(), now());
      row = this.get(i.intentId)!;
    } else if (row.payload_sha256 !== sha256Hex(payload) || row.trade_id !== i.terms.id) {
      return this.notPosted(i, "stored terms differ from the intent: refusing (terms are immutable)");
    }
    if (this.clock() >= i.deadlineMs) return this.notPosted(i, "posting deadline passed");

    // Keys, room, writers
    const maker = this.signers.get(i.makerId);
    const taker = this.signers.get(i.takerId);
    const fails: string[] = [];
    if (!maker || !taker) fails.push("signer not loaded");
    for (const id of [i.makerId, i.takerId]) if (!isTradable(getKey(this.db, id).status)) fails.push(`${id} is ${getKey(this.db, id).status}`);
    if (getRoom(this.db, this.room).status !== "READY") fails.push(`room ${this.room} is ${getRoom(this.db, this.room).status}`);
    if (maker && !fails.length) {
      try {
        if (!(await this.writers(i.sweep)).has(maker.did)) fails.push(`${i.makerId} may not write in ${this.room}`);
      } catch (e) {
        fails.push(`room writers unreadable: ${(e as Error).message}`);
      }
    }
    fails.push(...(await precheck()));
    if (fails.length) return this.notPosted(i, fails.join("; "));

    // Sign once, verify, freeze
    if (!row.text) {
      const t0 = this.clock();
      const s = buildSignedTrade(maker!, taker!, i.terms);
      if (!verifyEd25519(maker!.did, s.makerSig, makerSigningString(i.terms)) || !verifyEd25519(taker!.did, s.takerSig, takerSigningString(i.terms, taker!.did))) {
        return this.notPosted(i, "signature self-verification failed");
      }
      row = this.set(i.intentId, { text: s.text, state: "SIGNED", sign_start: iso(t0), sign_end: iso(this.clock()) });
    }
    if (this.clock() >= i.deadlineMs) return this.notPosted(i, "posting deadline passed after signing");
    return this.send(i, row);
  }

  private async send(i: ExecIntent, row: LiveTradeRow): Promise<ExecResult> {
    let a = this.journal.plan({ opKey: `trade:${row.trade_id}`, kind: "trade", signerId: row.maker_id, room: this.room, text: row.text! });
    if (a.state === "PLANNED") a = this.journal.prepare(a);          // outer nonce reserved + persisted
    this.set(i.intentId, { state: "POSTING", attempt_op: a.op_key, post_at: now() });
    a = await this.journal.send(a, { noResend: true });
    // 429 = not stored: the SAME signed body may go again, only while it can still land before the deadline.
    while (a.state === "PREPARED" && a.http_status === 429) {
      const wait = retryAfterS(a.response ?? "") * 1000;
      if (this.clock() + wait >= i.deadlineMs) return this.notPosted(i, "rate limited (429) until the posting deadline: nothing stored");
      await this.sleep(wait);
      a = await this.journal.send(a, { noResend: true });
    }
    if (a.state === "UNKNOWN" || a.state === "SENDING") a = await this.journal.readBackOnly(a);
    return this.finish(i.intentId, a);
  }

  private finish(intentId: string, a: AttemptRow): ExecResult {
    const state = a.state === "CONFIRMED" ? "POSTED" : a.state === "FAILED" ? "FAILED" : "UNKNOWN";
    const r = this.set(intentId, { state, response_at: now(), detail: a.error ?? (a.http_status ? `HTTP ${a.http_status}` : null) });
    const ms = (x: string | null, y: string | null) => (x && y ? Date.parse(y) - Date.parse(x) : null);
    ccLog("LIVE TRADE", { intent: intentId, trade_id: r.trade_id, sweep: r.sweep, state, http: a.http_status, nonce: a.nonce,
      decide_to_sign_ms: ms(r.decided_at, r.sign_start), sign_ms: ms(r.sign_start, r.sign_end), post_ms: ms(r.post_at, r.response_at),
      decide_to_response_ms: ms(r.decided_at, r.response_at), boundary_margin_ms: sweepTime(this.contest, r.sweep) - Date.parse(r.response_at!) });
    if (state === "UNKNOWN") {
      halt(this.db, "ambiguous_operation", `trade ${r.trade_id} (sweep ${r.sweep}): POST outcome unknown and not found by read-back; not re-sent`);
    }
    if (state === "FAILED") {
      this.db.prepare("UPDATE intents SET risk_status = 'NOT_SENT', risk_detail = ? WHERE intent_id = ?").run(JSON.stringify({ state, detail: r.detail }), intentId);
    }
    return { posted: state === "POSTED", state, detail: r.detail ?? "" };
  }

  /** Locate POSTED trades in our room: stamped before the boundary -> CONFIRMED, else LATE. Read-only. */
  async confirmPosted(): Promise<number> {
    const rows = this.db.prepare("SELECT * FROM live_trades WHERE state = 'POSTED' AND seq IS NULL").all() as LiveTradeRow[];
    for (const r of rows) {
      const a = this.journal.get(r.attempt_op!);
      if (!a) continue;
      const at = await this.journal.locate(a);
      if (!at?.ts) continue;
      const late = Date.parse(at.ts) > sweepTime(this.contest, r.sweep);
      this.set(r.intent_id, { state: late ? "LATE" : "CONFIRMED", seq: at.seq, stamped_at: at.ts });
      ccLog("LIVE TRADE", { trade_id: r.trade_id, sweep: r.sweep, seq: at.seq, stamped_at: at.ts, state: late ? "LATE" : "CONFIRMED",
        post_to_stamp_ms: r.post_at ? Date.parse(at.ts) - Date.parse(r.post_at) : null });
    }
    return rows.length;
  }

  onSettled(intentId: string, outcome: string, reason: string | null): void {
    const r = this.get(intentId);
    if (!r) return;
    const state = outcome === "not_applied" ? "NOT_APPLIED" : POSTED_STATES.includes(r.state) ? (outcome === "settled" ? "SETTLED" : "VOID") : r.state;
    this.set(intentId, { fold_outcome: reason ? `${outcome}:${reason}` : outcome, state });
  }

  async admissible(intentId: string, sweep: number): Promise<string> {
    let r = this.get(intentId);
    if (!r) return "exclude:no journal row";
    if (r.state === "POSTED") {
      await this.confirmPosted();
      r = this.get(intentId)!;
    }
    if (r.state === "LATE") return "exclude:stamped after the boundary";
    if (r.state !== "CONFIRMED") return r.state === "POSTED" ? "defer" : `exclude:state ${r.state}`;
    const flow = this.db.prepare("SELECT flow_json FROM sweeps WHERE n = ?").get(sweep) as { flow_json: string | null } | undefined;
    if (!flow?.flow_json) return "defer";
    const missed = ((JSON.parse(flow.flow_json) as { missed?: [string, number, number][] }).missed ?? []);
    if (missed.some(([room, a, b]) => room === this.room && r!.seq! >= a && r!.seq! <= b)) return "exclude:missed by the referee";
    return "include";
  }

  async recover(repost: (intentId: string) => Promise<string[] | null>): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM live_trades WHERE state IN ('CREATED','SIGNED','POSTING') ORDER BY created_at").all() as LiveTradeRow[];
    for (const r of rows) {
      const i: ExecIntent = { intentId: r.intent_id, sweep: r.sweep, pairIndex: r.pair_index ?? -1, makerId: r.maker_id, takerId: r.taker_id, ref: "",
        terms: JSON.parse(r.terms) as Terms, decidedAtMs: Date.parse(r.decided_at ?? now()), deadlineMs: sweepTime(this.contest, r.sweep) - this.guardMs };
      ccLog("EXECUTOR", { intent: r.intent_id, trade_id: r.trade_id, state: r.state }, "recovering a live trade interrupted by a restart");
      if (r.state === "POSTING") {
        let a = r.attempt_op ? this.journal.get(r.attempt_op) : undefined;
        if (!a) { this.notPosted(i, "no journal row: never sent"); continue; }
        if (a.state === "PREPARED" || a.state === "PLANNED") {
          if (this.clock() >= i.deadlineMs) { this.notPosted(i, "crash before sending; deadline passed"); continue; }
          if (a.state === "PLANNED") a = this.journal.prepare(a);
          a = await this.journal.send(a, { noResend: true });
          if (a.state === "UNKNOWN" || a.state === "SENDING") a = await this.journal.readBackOnly(a);
        } else if (a.state === "SENDING" || a.state === "UNKNOWN") {
          a = await this.journal.readBackOnly(a);                        // read only: NEVER re-sent
        }
        this.finish(r.intent_id, a);
        continue;
      }
      await this.post(i, async () => (await repost(r.intent_id)) ?? ["intent no longer pending in the engine"]);
    }
  }
}
