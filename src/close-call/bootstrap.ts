/**
 * Live bootstrap, one idempotent step at a time. Every write goes through the write journal
 * (persisted + signed before the network, read back before any resend), every promotion needs
 * evidence, and every step re-derives where it is from the database and the server -- so a crash,
 * a restart or a second `step()` call can never repeat a write.
 *
 * This module holds no key and makes no request itself: the caller passes the signers and the
 * Transport. In this build only tests and `bootstrap --dry-run` (an in-memory server) call it.
 *
 * Order (N = number of real keys in the live DB; progressive: 2 first, then 100):
 *
 *   1 claim      room-owners/<room> = CC001            (note, if_absent; only while the room is empty)
 *   2 allow      room-allow/<room>  = CC002..CCN        (one note; rewritten when keys are added)
 *   3 owner      {"t":"owner"} of CC001 in close1
 *   4 mint       CC001 MINT_CONFIRMED under the policy  (PROTOCOL: stamped sweep published, not missed)
 *   5 room       {"t":"room"} of our room in close1, by CC001
 *   6 listed     our room in flow.rooms -> REGISTER_CONFIRMED -> READY
 *   7 owners     {"t":"owner"} of CC002..CCN in OUR room (stamped after the sweep that listed it)
 *   8 mints      each key MINT_CONFIRMED under the policy -> READY
 *   9 test       one 0.10 trade CC001 -> CC002 in our room; wait until the referee resolves it
 *
 * Gates before ANY write: not halted, backup gate (verified encrypted backup of exactly these key
 * files), before the lock, every key has a signer. A time delay is never evidence.
 */

import { assessMint, type OwnerMessageRecord } from "./confirmation.js";
import { lastClosedSweep, type Contest } from "./contest.js";
import { CENT, fmt2, floorTo, toMicro } from "./decimal.js";
import { AmbiguousOperation, type AttemptRow, type Transport, type WriteJournal, type WriteOp } from "./journal.js";
import { getKey, listKeys, transitionKey, type ConfirmationPolicyName, type KeyRecord } from "./keys.js";
import { ccLog } from "./logger.js";
import { resolveProbe, type ProbeTrade } from "./probe.js";
import { newTradeId, ownerMessageText, roomMessageText, type Terms } from "./protocol.js";
import { buildSignedTrade, sha256Hex, type Signer } from "./protocol-writes.js";
import { allowListValue, findRoomRegistration, getRoom, planOwnershipRefresh, transitionRoom } from "./room.js";
import { halt, haltSummary, type HaltKind } from "./safety.js";
import { getMeta, now, setMeta, type CcDb } from "./store.js";

export const REGISTRY_ROOM = "close1";
export const TEST_QTY = "0.10";

export type Phase = "preflight" | "claim" | "allow" | "owner-first" | "wait-first-mint" | "room-register" | "wait-room"
  | "owners" | "wait-mints" | "test-trade" | "wait-test-trade" | "refresh" | "done";

export interface StepResult { phase: Phase; action: "wrote" | "waiting" | "blocked" | "halted" | "done"; detail: string; writes: number; blockers?: string[] }

export interface BootstrapDeps {
  db: CcDb;
  contest: Contest;
  journal: WriteJournal;
  transport: Transport;
  signers: Map<string, Signer>;
  policy: ConfirmationPolicyName;
  room: string;
  clock: () => number;
  /** Pull the referee's latest posts into db (the observer in live, the simulated referee in dry-run). */
  refreshReferee: () => Promise<void>;
  /** The backup gate (backup-gate.ts): ok only with a verified encrypted backup of exactly these key files. */
  gate: () => { ok: boolean; problems: string[] };
  /** Awaited between two writes, to stay inside the write budget. */
  pace?: () => Promise<void>;
  refreshDays?: number;
}

export class Bootstrap {
  constructor(private d: BootstrapDeps) {}

  private keys(): KeyRecord[] {
    return listKeys(this.d.db).filter((k) => k.fake === 0);
  }

  private stop(kind: HaltKind, reason: string, phase: Phase): StepResult {
    halt(this.d.db, kind, reason);
    return { phase, action: "halted", detail: reason, writes: 0 };
  }

  private async write(op: WriteOp, phase: Phase): Promise<AttemptRow | StepResult> {
    try {
      let row = await this.d.journal.execute(op);
      if (row.state === "UNKNOWN" || row.state === "SENDING") row = await this.d.journal.resolve(row);   // read back now, never a blind resend
      if (row.state !== "CONFIRMED" && row.state !== "FAILED") return this.stop("ambiguous_operation", `${op.opKey} is ${row.state} after resolution`, phase);
      if (row.state === "FAILED") return this.stop("manual", `${op.opKey} refused by the server: HTTP ${row.http_status} ${row.response?.slice(0, 160) ?? ""}`, phase);
      ccLog("BOOTSTRAP", { phase, op: op.opKey, state: row.state, nonce: row.nonce }, "write journaled");
      await this.d.pace?.();
      return row;
    } catch (e) {
      if (e instanceof AmbiguousOperation) return this.stop("ambiguous_operation", (e as Error).message, phase);
      throw e;
    }
  }

  private ownerRecord(id: string): OwnerMessageRecord | undefined {
    const raw = getMeta(this.d.db, `owner_msg:${id}`);
    return raw ? (JSON.parse(raw) as OwnerMessageRecord) : undefined;
  }

  private async registerOwner(k: KeyRecord, room: string, phase: Phase, repost = 0): Promise<StepResult | null> {
    const text = ownerMessageText(k.did);
    const r = await this.write({ opKey: repost ? `owner:${k.id}:r${repost}` : `owner:${k.id}`, kind: "owner", signerId: k.id, room, text }, phase);
    if (!("attempt_id" in r)) return r;
    const at = await this.d.journal.locate(r);
    if (!at?.ts) return this.stop("ambiguous_operation", `owner:${k.id} confirmed but not found in ${room} by read-back`, phase);
    setMeta(this.d.db, `owner_msg:${k.id}`, JSON.stringify({ did: k.did, room, seq: at.seq, ts: at.ts, text } satisfies OwnerMessageRecord));
    if (getKey(this.d.db, k.id).status === "GENERATED") transitionKey(this.d.db, k.id, "REGISTER_PENDING", { reason: `owner message ${room}#${at.seq}` });
    return null;
  }

  /** Promote keys whose owner message now has evidence the policy accepts. */
  private assessMints(roomReady: boolean): { pending: KeyRecord[]; blockers: string[] } {
    const pending: KeyRecord[] = [];
    const blockers: string[] = [];
    for (const k of this.keys()) {
      if (["REGISTER_PENDING", "MINT_EXPECTED"].includes(k.status)) {
        const msg = this.ownerRecord(k.id);
        if (!msg) { blockers.push(`${k.id}: no owner-message record`); pending.push(k); continue; }
        const a = assessMint(this.d.db, this.d.contest, { did: k.did, policy: this.d.policy, ownerMessage: msg });
        if (a.confirmed) {
          transitionKey(this.d.db, k.id, "MINT_CONFIRMED", { evidence: a.confirmed, policy: this.d.policy });
          ccLog("KEYS", { key: k.id, evidence: a.confirmed.source, sweep: a.confirmed.sweep, policy: this.d.policy }, "MINT_CONFIRMED");
        } else {
          if (a.expected && k.status === "REGISTER_PENDING" && a.expected.source === "protocol") transitionKey(this.d.db, k.id, "MINT_EXPECTED", { evidence: a.expected });
          blockers.push(...a.blockers.map((b) => `${k.id}: ${b}`));
          if (!a.blockers.length) blockers.push(`${k.id}: no evidence accepted by ${this.d.policy} yet`);
          pending.push(getKey(this.d.db, k.id));
          continue;
        }
      }
      const cur = getKey(this.d.db, k.id);
      if (cur.status === "MINT_CONFIRMED" && roomReady) transitionKey(this.d.db, k.id, "READY");
    }
    return { pending, blockers };
  }

  private lastPublished(): number {
    return (this.d.db.prepare("SELECT MAX(n) m FROM sweeps WHERE flow_json IS NOT NULL").get() as { m: number | null }).m ?? 0;
  }

  /** Run the next step. Never more than one phase of writes per call. */
  async step(): Promise<StepResult> {
    const { db, room } = this.d;
    const h = haltSummary(db);
    if (h) return { phase: "preflight", action: "halted", detail: h, writes: 0 };
    const keys = this.keys();
    const blockers: string[] = [];
    if (keys.length < 2) blockers.push(`need at least 2 real keys in the live DB, have ${keys.length}`);
    for (const k of keys) if (!this.d.signers.has(k.id)) blockers.push(`${k.id}: no signer loaded`);
    const gate = this.d.gate();
    if (!gate.ok) blockers.push(...gate.problems.map((p) => `backup gate: ${p}`));
    if (lastClosedSweep(this.d.contest, this.d.clock()) >= this.d.contest.lockSweep) blockers.push("the contest is locked");
    if (blockers.length) return { phase: "preflight", action: "blocked", detail: "preflight failed: nothing written", writes: 0, blockers };

    await this.d.refreshReferee();
    const [first, second] = keys;
    let r = getRoom(db, room);

    // 1 claim
    if (r.status === "UNCREATED") {
      const owner = await this.d.transport.readNote("room-owners", room);
      if (owner !== null && owner !== first.did) return this.stop("room_ownership", `room-owners/${room} already holds ${owner}: pick another CLOSECALL_ROOM`, "claim");
      if (owner === null) {
        const view = await this.d.transport.readRoom(room, 0);
        if (view.last_seq > 0) return this.stop("room_ownership", `${room} already has messages and no owner: it can never be claimed; pick another CLOSECALL_ROOM`, "claim");
        const w = await this.write({ opKey: `claim:${room}`, kind: "note-owners", signerId: first.id, room, value: first.did, ifAbsent: true }, "claim");
        if (!("attempt_id" in w)) return w;
      }
      const back = await this.d.transport.readNote("room-owners", room);
      if (back !== first.did) return this.stop("room_ownership", `room-owners/${room} reads ${back} after our claim`, "claim");
      transitionRoom(db, room, "CLAIMED", { kind: "owner-note", owner: back }, first.did);
      return { phase: "claim", action: "wrote", detail: `${room} claimed by ${first.id}`, writes: owner === null ? 1 : 0 };
    }

    // 2 allow-list (also grows it when keys are added later; never drops or accepts a foreign DID)
    const desired = allowListValue(keys.slice(1).map((k) => k.did));
    const currentAllow = await this.d.transport.readNote("room-allow", room);
    if (currentAllow !== desired) {
      const ours = new Set(keys.map((k) => k.did));
      const foreign = (currentAllow ?? "").split(/\s+/).filter((x) => x && !ours.has(x));
      if (foreign.length) return this.stop("room_ownership", `room-allow/${room} holds ${foreign.length} DIDs that are not ours: not overwriting`, "allow");
      const w = await this.write({ opKey: `allow:${room}:${sha256Hex(desired).slice(0, 16)}`, kind: "note-allow", signerId: first.id, room, value: desired }, "allow");
      if (!("attempt_id" in w)) return w;
      const back = await this.d.transport.readNote("room-allow", room);
      if (back !== desired) return this.stop("room_ownership", `room-allow/${room} does not read back as written`, "allow");
      if (r.status === "CLAIMED") transitionRoom(db, room, "ALLOWLIST_PENDING", { kind: "allow-sent", dids: keys.length - 1 });
      return { phase: "allow", action: "wrote", detail: `allow-list = ${keys.length - 1} DIDs`, writes: 1 };
    }
    if (r.status === "CLAIMED") r = transitionRoom(db, room, "ALLOWLIST_PENDING", { kind: "allow-sent", dids: keys.length - 1 });

    // 3 owner CC001 in close1
    if (getKey(db, first.id).status === "GENERATED") {
      const s = await this.registerOwner(first, REGISTRY_ROOM, "owner-first");
      if (s) return s;
      return { phase: "owner-first", action: "wrote", detail: `${first.id} owner message in ${REGISTRY_ROOM}`, writes: 1 };
    }

    // 4 CC001's mint (and everyone else's, whenever evidence arrives)
    const roomReadyBefore = r.status === "READY";
    const m = this.assessMints(roomReadyBefore);
    // An owner message inside a range the referee reported as missed was never read: post it again
    // (a second registration of a key is harmless -- one mint per key). Bounded, then manual.
    for (const k of m.pending) {
      if (!m.blockers.some((b) => b.startsWith(`${k.id}:`) && b.includes("range the referee missed"))) continue;
      const tries = Number(getMeta(db, `owner_reposts:${k.id}`) ?? "0");
      if (tries >= 3) return this.stop("manual", `${k.id}: owner message missed by the referee ${tries + 1} times`, "wait-mints");
      setMeta(db, `owner_reposts:${k.id}`, String(tries + 1));
      const rec = this.ownerRecord(k.id)!;
      const s = await this.registerOwner(k, rec.room, "wait-mints", tries + 1);
      if (s) return s;
      return { phase: "wait-mints", action: "wrote", detail: `${k.id}: owner message was in a missed range; reposted in ${rec.room}`, writes: 1 };
    }
    const firstNow = getKey(db, first.id);
    if (!["MINT_CONFIRMED", "READY", "ACTIVE"].includes(firstNow.status)) {
      return { phase: "wait-first-mint", action: "waiting", detail: `${first.id} is ${firstNow.status}; last published sweep ${this.lastPublished()}`, writes: 0, blockers: m.blockers };
    }

    // 5 room registration in close1, by CC001
    if (r.status === "ALLOWLIST_PENDING") {
      const text = roomMessageText(room);
      const w = await this.write({ opKey: `room:${room}`, kind: "room", signerId: first.id, room: REGISTRY_ROOM, text }, "room-register");
      if (!("attempt_id" in w)) return w;
      const at = await this.d.journal.locate(w);
      if (!at) return this.stop("ambiguous_operation", `room:${room} confirmed but not found by read-back`, "room-register");
      transitionRoom(db, room, "REGISTER_PENDING", { kind: "allow-note+room-message", value_sha256: sha256Hex(desired), dids: keys.length - 1, room_message_seq: at.seq });
      return { phase: "room-register", action: "wrote", detail: `{"t":"room"} for ${room} in ${REGISTRY_ROOM} #${at.seq}`, writes: 1 };
    }

    // 6 listed by the referee
    if (r.status === "REGISTER_PENDING") {
      const n = findRoomRegistration(db, room);
      if (n === null) return { phase: "wait-room", action: "waiting", detail: `${room} not in flow.rooms yet (last published sweep ${this.lastPublished()})`, writes: 0 };
      r = transitionRoom(db, room, "REGISTER_CONFIRMED", { kind: "flow.rooms", sweep: n });
      r = transitionRoom(db, room, "READY", { kind: "owner-mint-confirmed", owner: first.did, sweep: firstNow.minted_sweep ?? n });
      this.assessMints(true);
      ccLog("ROOM", { room, sweep: n }, "room listed by the referee: REGISTER_CONFIRMED -> READY");
    }

    // 7 owners CC002..CCN in our room
    const unregistered = this.keys().filter((k) => k.status === "GENERATED");
    if (unregistered.length) {
      let writes = 0;
      for (const k of unregistered) {
        const s = await this.registerOwner(k, room, "owners");
        if (s) return { ...s, writes };
        writes++;
      }
      return { phase: "owners", action: "wrote", detail: `${writes} owner messages in ${room}`, writes };
    }

    // 8 mints
    const m2 = this.assessMints(true);
    if (m2.pending.length) {
      return { phase: "wait-mints", action: "waiting", detail: `${m2.pending.length} keys not confirmed yet (policy ${this.d.policy})`, writes: 0, blockers: m2.blockers.slice(0, 20) };
    }

    // 9 test trade CC001 -> CC002
    const testId = getMeta(db, "test_trade_id");
    if (!testId) {
      const sweep = this.lastPublished();
      const ref = (db.prepare("SELECT ref_px FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n DESC LIMIT 1").get() as { ref_px: string } | undefined)?.ref_px;
      if (!ref) return { phase: "test-trade", action: "waiting", detail: "no reference price observed yet", writes: 0 };
      const terms: Terms = { id: newTradeId(), maker: first.did, px: fmt2(floorTo(toMicro(ref), CENT)), qty: TEST_QTY, side: "buy", taker: second.did, until: sweep + 6 };
      db.transaction(() => {
        db.prepare(`INSERT INTO trades (trade_id, kind, sweep_first, until, maker_id, taker_id, side, qty, px, terms, status, created_at, updated_at)
          VALUES (?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`).run(terms.id, sweep + 1, terms.until, first.id, second.id, terms.side, terms.qty, terms.px, JSON.stringify(terms), now(), now());
        setMeta(db, "test_trade_id", terms.id);
      })();
      return this.postTrade(terms.id, 0);
    }
    const t = db.prepare("SELECT * FROM trades WHERE trade_id = ?").get(testId) as ProbeTrade & { terms: string; status: string };
    if (t.status !== "settled") {
      const a = resolveProbe(db, t, this.lastPublished());
      const setStatus = (s: string, reason?: string) => db.prepare("UPDATE trades SET status = ?, reason = ?, updated_at = ? WHERE trade_id = ?").run(s, reason ?? null, now(), t.trade_id);
      switch (a.kind) {
        case "resolved-settled":
          setStatus("settled");
          ccLog("BOOTSTRAP", { trade: t.trade_id, sweep: a.sweep }, "test trade settled");
          break;
        case "repost-same":
        case "wait":
          if (t.status === "planned") return this.postTrade(t.trade_id, 0);
          return { phase: "wait-test-trade", action: "waiting", detail: `test trade ${t.trade_id}: ${a.why}`, writes: 0 };
        case "resolved-void":
          setStatus("void", a.reason);
          if (a.retrySameId) return this.postTrade(t.trade_id, a.sweep);
          return this.stop("manual", `test trade ${t.trade_id} void:${a.reason} at sweep ${a.sweep}: investigate before scaling`, "wait-test-trade");
        case "query-repost":
          return this.postTrade(t.trade_id, this.lastPublished());
        case "resolved-never-settled":
          setStatus("never-settled");
          return this.stop("manual", `test trade ${t.trade_id} never settled (void:expired at ${a.sweep}): investigate before scaling`, "wait-test-trade");
        case "ambiguous":
          return this.stop("ambiguous_operation", `test trade ${t.trade_id}: ${a.why}`, "wait-test-trade");
      }
    }

    // ownership refresh (every refreshDays; reads both notes first, never overwrites something else)
    const last = getMeta(db, "room_refresh_at");
    const plan = await planOwnershipRefresh(this.d.transport, { room, ownerId: first.id, ownerDid: first.did, allowDids: keys.slice(1).map((k) => k.did),
      lastRefreshMs: last ? Date.parse(last) : Date.parse(getMeta(db, "bootstrap_done_at") ?? new Date(this.d.clock()).toISOString()), nowMs: this.d.clock(), days: this.d.refreshDays ?? 5 });
    if (plan.action === "halt") return this.stop("room_ownership", plan.reason, "refresh");
    if (plan.action === "refresh") {
      for (const w of plan.writes) {
        const res = await this.write(w, "refresh");
        if (!("attempt_id" in res)) return res;
      }
      setMeta(db, "room_refresh_at", new Date(this.d.clock()).toISOString());
      return { phase: "refresh", action: "wrote", detail: "room-owners and room-allow re-signed with their current values", writes: 2 };
    }
    if (!getMeta(db, "bootstrap_done_at")) setMeta(db, "bootstrap_done_at", new Date(this.d.clock()).toISOString());
    return { phase: "done", action: "done", detail: `${keys.length} keys READY, room ${room} READY, test trade settled`, writes: 0 };
  }

  /** Sign (once) and post the test trade. A repost after a void or `until` uses a new op key but the SAME signed trade text. */
  private async postTrade(tradeId: string, repostTag: number): Promise<StepResult> {
    const db = this.d.db;
    const t = db.prepare("SELECT * FROM trades WHERE trade_id = ?").get(tradeId) as { terms: string; maker_id: string; taker_id: string; evidence: string | null };
    let text = t.evidence ? (JSON.parse(t.evidence) as { text: string }).text : null;
    if (!text) {
      const maker = this.d.signers.get(t.maker_id)!;
      const taker = this.d.signers.get(t.taker_id)!;
      text = buildSignedTrade(maker, taker, JSON.parse(t.terms) as Terms).text;
      db.prepare("UPDATE trades SET evidence = ?, status = 'signed', updated_at = ? WHERE trade_id = ?").run(JSON.stringify({ text }), now(), tradeId);
    }
    const w = await this.write({ opKey: `trade:${tradeId}:${repostTag}`, kind: "trade", signerId: t.maker_id, room: this.d.room, text }, "test-trade");
    if (!("attempt_id" in w)) return w;
    db.prepare("UPDATE trades SET status = 'posted', updated_at = ? WHERE trade_id = ?").run(now(), tradeId);
    return { phase: "test-trade", action: "wrote", detail: `test trade ${tradeId} (${TEST_QTY}) posted in ${this.d.room}${repostTag ? ` (repost after sweep ${repostTag})` : ""}`, writes: 1 };
  }
}
