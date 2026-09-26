/**
 * Live bootstrap, one idempotent step at a time. Every write goes through the write journal
 * (persisted + signed before the network, read back before any resend; a 429 keeps the same signed
 * body for a later send), every promotion needs evidence, and every step re-derives where it is from
 * the database and the server -- so a crash, a restart or a second `step()` never repeats a write.
 *
 * Key roles (keys.role): CC-ADMIN owns and registers the room and never trades; CC-TEST-001/002 make
 * the 0.10 staging trade; CC001..CC100 are the strategy keys and stay untouched (10,000 POLF, flat).
 *
 *   1 claim     room-owners/<room> = CC-ADMIN              (note, if_absent; only while the room is empty)
 *   2 allow     room-allow/<room> = staging + strategy DIDs (one note, CAS `if` = the value read before)
 *   3 owner     {"t":"owner"} of CC-ADMIN in close1
 *   4 mint      CC-ADMIN MINT_CONFIRMED (PROTOCOL: stamped sweep published, not missed, owner count grew)
 *   5 room      {"t":"room"} of our room in close1, by CC-ADMIN
 *   6 listed    our room in flow.rooms -> REGISTER_CONFIRMED -> READY
 *   7 owners    staging keys' {"t":"owner"} in OUR room (stamped after the sweep that listed it)
 *   8 mints     staging MINT_CONFIRMED -> READY
 *   9 test      0.10 CC-TEST-001 -> CC-TEST-002 in our room; SETTLED by the same evidence as a live trade:
 *               located in our room, stamped before a published sweep's boundary, outside every missed
 *               range, then the official fold at that sweep's ref/close (the truncated lists only cross-check)
 *  10 owners    strategy keys (only after the test trade SETTLED), paced to the live write budget
 *  11 mints     strategy MINT_CONFIRMED -> READY                       => done
 *
 * Gates before ANY write: not halted, backup gate (verified encrypted backup of exactly these key
 * files), before the lock, exactly one admin, two staging keys, a signer for every key.
 */

import { assessMint, type OwnerMessageRecord } from "./confirmation.js";
import { lastClosedSweep, sweepForTime, sweepTime, type Contest } from "./contest.js";
import { CENT, fmt2, floorTo, toMicro } from "./decimal.js";
import { AmbiguousOperation, retryAfterS, type AttemptRow, type Transport, type WriteJournal, type WriteOp } from "./journal.js";
import { getKey, keysByRole, listKeys, transitionKey, type ConfirmationPolicyName, type KeyRecord } from "./keys.js";
import type { IsolatedTradeInput, IsolatedTradeResult } from "./fold.js";
import type { WireTrade } from "./ledger.js";
import { ccLog } from "./logger.js";
import { resolveProbe, type ProbeTrade } from "./probe.js";
import { newTradeId, ownerMessageText, roomMessageText, type Terms } from "./protocol.js";
import { buildSignedTrade, sha256Hex, type Signer } from "./protocol-writes.js";
import { allowListValue, findRoomRegistration, getRoom, planOwnershipRefresh, transitionRoom } from "./room.js";
import { halt, haltSummary, WriterDisarmed, type HaltKind } from "./safety.js";
import { getMeta, now, setMeta, type CcDb } from "./store.js";

export const REGISTRY_ROOM = "close1";
export const TEST_QTY = "0.10";

export type Phase = "preflight" | "claim" | "allow" | "owner-admin" | "wait-admin-mint" | "room-register" | "wait-room"
  | "owners-staging" | "wait-staging-mints" | "test-trade" | "wait-test-trade" | "owners-strategy" | "wait-strategy-mints" | "refresh" | "done";

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
  /** Awaited after a 429 before sending the same body again. */
  sleep?: (ms: number) => Promise<void>;
  refreshDays?: number;
  /**
   * The official fold on the staging trade alone (fold.ts isolatedTradeFold). Without it the staging trade can
   * only settle by the referee's lists, which are truncated (the dry-run's simulated referee lists everything).
   */
  foldTest?: (p: IsolatedTradeInput) => Promise<IsolatedTradeResult>;
}

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared by Bootstrap and RoomKeeper: journaled write with 429 back-off, UNKNOWN resolved by read-back, anything else ambiguous halts. */
export async function journaledWrite(d: Pick<BootstrapDeps, "db" | "journal" | "pace" | "sleep">, op: WriteOp, label: string):
  Promise<{ row: AttemptRow } | { halted: string } | { blocked: string }> {
  try {
    let row = await d.journal.execute(op);
    for (let i = 0; row.state === "PREPARED" && row.http_status === 429 && i < 6; i++) {
      await (d.sleep ?? realSleep)(retryAfterS(row.response ?? "") * 1000 * (i + 1));
      row = await d.journal.send(row);
    }
    if (row.state === "PREPARED" && row.http_status === 429) { halt(d.db, "manual", `${op.opKey}: still rate limited after 6 waits`); return { halted: "rate limited" }; }
    if (row.state === "UNKNOWN" || row.state === "SENDING") row = await d.journal.resolve(row);
    if (row.state === "FAILED") { const why = `${op.opKey} refused by the server: HTTP ${row.http_status} ${row.response?.slice(0, 160) ?? ""}`; halt(d.db, "manual", why); return { halted: why }; }
    if (row.state !== "CONFIRMED") { const why = `${op.opKey} is ${row.state} after resolution`; halt(d.db, "ambiguous_operation", why); return { halted: why }; }
    ccLog("BOOTSTRAP", { phase: label, op: op.opKey, state: row.state, nonce: row.nonce }, "write journaled");
    await d.pace?.();
    return { row };
  } catch (e) {
    if (e instanceof WriterDisarmed) return { blocked: (e as Error).message };
    if (e instanceof AmbiguousOperation) { halt(d.db, "ambiguous_operation", (e as Error).message); return { halted: (e as Error).message }; }
    throw e;
  }
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
    const r = await journaledWrite(this.d, op, phase);
    if ("row" in r) return r.row;
    if ("blocked" in r) return { phase, action: "blocked", detail: r.blocked, writes: 0 };
    return { phase, action: "halted", detail: r.halted, writes: 0 };
  }

  /** Read a note back after writing it: a mismatch is re-read (up to ~30 s: edge caches) before it counts. */
  private async readBack(ns: "room-owners" | "room-allow", expected: string): Promise<string | null> {
    let got: string | null = null;
    for (let i = 0; i < 6; i++) {
      if (i) await (this.d.sleep ?? realSleep)(5_000);
      got = await this.d.transport.readNote(ns, this.d.room);
      if (got === expected) return got;
    }
    return got;
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
    // How many of OUR registrations were stamped for each sweep (PROTOCOL corroboration against the owner count).
    const perSweep = new Map<number, number>();
    for (const k of this.keys()) {
      const m = this.ownerRecord(k.id);
      if (m) { const s = sweepForTime(this.d.contest, Date.parse(m.ts)); perSweep.set(s, (perSweep.get(s) ?? 0) + 1); }
    }
    for (const k of this.keys()) {
      if (["REGISTER_PENDING", "MINT_EXPECTED"].includes(k.status)) {
        const msg = this.ownerRecord(k.id);
        if (!msg) { blockers.push(`${k.id}: no owner-message record`); pending.push(k); continue; }
        const a = assessMint(this.d.db, this.d.contest, { did: k.did, policy: this.d.policy, ownerMessage: msg,
          ourInSameSweep: perSweep.get(sweepForTime(this.d.contest, Date.parse(msg.ts))) ?? 1 });
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

  /** An owner message the referee reported as missed was never read: post it again (one mint per key; bounded). */
  private async repostMissed(pending: KeyRecord[], blockers: string[], phase: Phase): Promise<StepResult | null> {
    for (const k of pending) {
      if (!blockers.some((b) => b.startsWith(`${k.id}:`) && b.includes("range the referee missed"))) continue;
      const tries = Number(getMeta(this.d.db, `owner_reposts:${k.id}`) ?? "0");
      if (tries >= 3) return this.stop("manual", `${k.id}: owner message missed by the referee ${tries + 1} times`, phase);
      setMeta(this.d.db, `owner_reposts:${k.id}`, String(tries + 1));
      const rec = this.ownerRecord(k.id)!;
      const s = await this.registerOwner(k, rec.room, phase, tries + 1);
      if (s) return s;
      return { phase, action: "wrote", detail: `${k.id}: owner message was in a missed range; reposted in ${rec.room}`, writes: 1 };
    }
    return null;
  }

  /** Run the next step. Never more than one phase of writes per call. */
  async step(): Promise<StepResult> {
    const { db, room } = this.d;
    const h = haltSummary(db);
    if (h) return { phase: "preflight", action: "halted", detail: h, writes: 0 };
    const keys = this.keys();
    const admin = keysByRole(db, "admin");
    const staging = keysByRole(db, "staging");
    const strategy = keysByRole(db, "strategy");
    const blockers: string[] = [];
    if (admin.length !== 1) blockers.push(`need exactly one admin key (CC-ADMIN), have ${admin.length}`);
    if (staging.length !== 2) blockers.push(`need two staging keys (CC-TEST-001/002), have ${staging.length}`);
    if (keys.some((k) => !k.role)) blockers.push("a real key has no role");
    for (const k of keys) if (!this.d.signers.has(k.id)) blockers.push(`${k.id}: no signer loaded`);
    const gate = this.d.gate();
    if (!gate.ok) blockers.push(...gate.problems.map((p) => `backup gate: ${p}`));
    if (lastClosedSweep(this.d.contest, this.d.clock()) >= this.d.contest.lockSweep) blockers.push("the contest is locked");
    if (blockers.length) return { phase: "preflight", action: "blocked", detail: "preflight failed: nothing written", writes: 0, blockers };

    await this.d.refreshReferee();
    const owner = admin[0];
    let r = getRoom(db, room);

    // 1 claim
    if (r.status === "UNCREATED") {
      const held = await this.d.transport.readNote("room-owners", room);
      if (held !== null && held !== owner.did) return this.stop("room_ownership", `room-owners/${room} already holds ${held}: pick another CLOSECALL_ROOM`, "claim");
      if (held === null) {
        const view = await this.d.transport.readRoom(room, 0);
        if (view.last_seq > 0) return this.stop("room_ownership", `${room} already has messages and no owner: it can never be claimed; pick another CLOSECALL_ROOM`, "claim");
        const w = await this.write({ opKey: `claim:${room}`, kind: "note-owners", signerId: owner.id, room, value: owner.did, ifAbsent: true }, "claim");
        if (!("attempt_id" in w)) return w;
      }
      const back = await this.readBack("room-owners", owner.did);
      if (back !== owner.did) return this.stop("room_ownership", `room-owners/${room} reads ${back} after our claim`, "claim");
      transitionRoom(db, room, "CLAIMED", { kind: "owner-note", owner: back }, owner.did);
      return { phase: "claim", action: "wrote", detail: `${room} claimed by ${owner.id}`, writes: held === null ? 1 : 0 };
    }

    // 2 allow-list = every non-admin key (compare-and-set against the value just read; never a foreign DID)
    const desired = allowListValue([...staging, ...strategy].map((k) => k.did));
    const currentAllow = await this.d.transport.readNote("room-allow", room);
    if (currentAllow !== desired) {
      const ours = new Set(keys.map((k) => k.did));
      const foreign = (currentAllow ?? "").split(/\s+/).filter((x) => x && !ours.has(x));
      if (foreign.length) return this.stop("room_ownership", `room-allow/${room} holds ${foreign.length} DIDs that are not ours: not overwriting`, "allow");
      // No `if` compare-and-set: it would repeat the whole old list in the body; only CC-ADMIN can sign this note and we read it just before.
      const w = await this.write({ opKey: `allow:${room}:${sha256Hex(desired).slice(0, 16)}`, kind: "note-allow", signerId: owner.id, room, value: desired }, "allow");
      if (!("attempt_id" in w)) return w;
      const back = await this.readBack("room-allow", desired);
      if (back !== desired) return this.stop("room_ownership", `room-allow/${room} does not read back as written`, "allow");
      setMeta(db, "room_allow_seen", JSON.stringify(back.split(" ")));
      if (r.status === "CLAIMED") transitionRoom(db, room, "ALLOWLIST_PENDING", { kind: "allow-sent", dids: staging.length + strategy.length });
      return { phase: "allow", action: "wrote", detail: `allow-list = ${staging.length + strategy.length} DIDs (${desired.length} chars)`, writes: 1 };
    }
    if (r.status === "CLAIMED") r = transitionRoom(db, room, "ALLOWLIST_PENDING", { kind: "allow-sent", dids: staging.length + strategy.length });

    // 3 owner CC-ADMIN in close1
    if (getKey(db, owner.id).status === "GENERATED") {
      const s = await this.registerOwner(owner, REGISTRY_ROOM, "owner-admin");
      if (s) return s;
      return { phase: "owner-admin", action: "wrote", detail: `${owner.id} owner message in ${REGISTRY_ROOM}`, writes: 1 };
    }

    // 4 mints (all keys, whenever evidence arrives); CC-ADMIN first
    const m = this.assessMints(r.status === "READY");
    const missed = await this.repostMissed(m.pending, m.blockers, "wait-admin-mint");
    if (missed) return missed;
    if (!["MINT_CONFIRMED", "READY"].includes(getKey(db, owner.id).status)) {
      return { phase: "wait-admin-mint", action: "waiting", detail: `${owner.id} is ${getKey(db, owner.id).status}; last published sweep ${this.lastPublished()}`, writes: 0, blockers: m.blockers };
    }

    // 5 room registration in close1, by CC-ADMIN
    if (r.status === "ALLOWLIST_PENDING") {
      const w = await this.write({ opKey: `room:${room}`, kind: "room", signerId: owner.id, room: REGISTRY_ROOM, text: roomMessageText(room) }, "room-register");
      if (!("attempt_id" in w)) return w;
      const at = await this.d.journal.locate(w);
      if (!at) return this.stop("ambiguous_operation", `room:${room} confirmed but not found by read-back`, "room-register");
      transitionRoom(db, room, "REGISTER_PENDING", { kind: "allow-note+room-message", value_sha256: sha256Hex(desired), dids: staging.length + strategy.length, room_message_seq: at.seq });
      return { phase: "room-register", action: "wrote", detail: `{"t":"room"} for ${room} in ${REGISTRY_ROOM} #${at.seq}`, writes: 1 };
    }

    // 6 listed by the referee
    if (r.status === "REGISTER_PENDING") {
      const n = findRoomRegistration(db, room);
      if (n === null) return { phase: "wait-room", action: "waiting", detail: `${room} not in flow.rooms yet (last published sweep ${this.lastPublished()})`, writes: 0 };
      transitionRoom(db, room, "REGISTER_CONFIRMED", { kind: "flow.rooms", sweep: n });
      r = transitionRoom(db, room, "READY", { kind: "owner-mint-confirmed", owner: owner.did, sweep: getKey(db, owner.id).minted_sweep ?? n });
      this.assessMints(true);
      ccLog("ROOM", { room, sweep: n }, "room listed by the referee: REGISTER_CONFIRMED -> READY");
    }

    // 7 staging owners in our room (two messages at once: the room never sits on a single message, the 12 h reap rule)
    const regStaging = staging.map((k) => getKey(db, k.id)).filter((k) => k.status === "GENERATED");
    if (regStaging.length) {
      for (const k of regStaging) { const s = await this.registerOwner(k, room, "owners-staging"); if (s) return s; }
      const v = await this.d.transport.readRoom(room, 0);
      const g = checkGeneration(db, room, v.generation, v.last_seq);
      if (g) return this.stop("room_ownership", g, "owners-staging");
      return { phase: "owners-staging", action: "wrote", detail: `${regStaging.length} staging owner messages in ${room}`, writes: regStaging.length };
    }

    // 8 staging mints
    const m2 = this.assessMints(true);
    const missed2 = await this.repostMissed(m2.pending, m2.blockers, "wait-staging-mints");
    if (missed2) return missed2;
    const stagingNow = staging.map((k) => getKey(db, k.id));
    if (!stagingNow.every((k) => ["READY", "ACTIVE"].includes(k.status))) {
      return { phase: "wait-staging-mints", action: "waiting", detail: `staging keys ${stagingNow.map((k) => `${k.id}:${k.status}`).join(" ")}`, writes: 0, blockers: m2.blockers.slice(0, 10) };
    }

    // 9 staging test trade 0.10
    const test = await this.testTrade(stagingNow[0], stagingNow[1]);
    if (test) return test;

    // 10 strategy owners (only after the staging trade SETTLED)
    const regStrategy = strategy.map((k) => getKey(db, k.id)).filter((k) => k.status === "GENERATED");
    if (regStrategy.length) {
      let writes = 0;
      for (const k of regStrategy) { const s = await this.registerOwner(k, room, "owners-strategy"); if (s) return { ...s, writes }; writes++; }
      return { phase: "owners-strategy", action: "wrote", detail: `${writes} strategy owner messages in ${room}`, writes };
    }

    // 11 strategy mints
    const m3 = this.assessMints(true);
    const missed3 = await this.repostMissed(m3.pending, m3.blockers, "wait-strategy-mints");
    if (missed3) return missed3;
    if (m3.pending.length) {
      return { phase: "wait-strategy-mints", action: "waiting", detail: `${m3.pending.length} keys not confirmed yet (policy ${this.d.policy})`, writes: 0, blockers: m3.blockers.slice(0, 20) };
    }

    // ownership refresh (also done by the live service's RoomKeeper)
    const last = getMeta(db, "room_refresh_at");
    const plan = await planOwnershipRefresh(this.d.transport, { room, ownerId: owner.id, ownerDid: owner.did, allowDids: [...staging, ...strategy].map((k) => k.did),
      lastRefreshMs: last ? Date.parse(last) : Date.parse(getMeta(db, "bootstrap_done_at") ?? new Date(this.d.clock()).toISOString()), nowMs: this.d.clock(), days: this.d.refreshDays ?? 5 });
    if (plan.action === "halt") return this.stop("room_ownership", plan.reason, "refresh");
    if (plan.action === "refresh") {
      for (const w of plan.writes) { const res = await this.write(w, "refresh"); if (!("attempt_id" in res)) return res; }
      setMeta(db, "room_refresh_at", new Date(this.d.clock()).toISOString());
      return { phase: "refresh", action: "wrote", detail: "room-owners and room-allow re-signed with their current values", writes: 2 };
    }
    if (!getMeta(db, "bootstrap_done_at")) setMeta(db, "bootstrap_done_at", new Date(this.d.clock()).toISOString());
    return { phase: "done", action: "done", detail: `admin + ${staging.length} staging + ${strategy.length} strategy keys READY, room ${room} READY, staging trade settled`, writes: 0 };
  }

  /** The 0.10 staging trade: planned once (id persisted), signed once, reposted only per the probe rules. null = settled. */
  private async testTrade(maker: KeyRecord, taker: KeyRecord): Promise<StepResult | null> {
    const db = this.d.db;
    if (getMeta(db, "test_trade_settled")) return null;
    const testId = getMeta(db, "test_trade_id");
    if (!testId) {
      const sweep = this.lastPublished();
      const ref = (db.prepare("SELECT ref_px FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n DESC LIMIT 1").get() as { ref_px: string } | undefined)?.ref_px;
      if (!ref) return { phase: "test-trade", action: "waiting", detail: "no reference price observed yet", writes: 0 };
      const terms: Terms = { id: newTradeId(), maker: maker.did, px: fmt2(floorTo(toMicro(ref), CENT)), qty: TEST_QTY, side: "buy", taker: taker.did, until: sweep + 6 };
      db.transaction(() => {
        db.prepare(`INSERT INTO trades (trade_id, kind, sweep_first, until, maker_id, taker_id, side, qty, px, terms, status, created_at, updated_at)
          VALUES (?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`).run(terms.id, sweep + 1, terms.until, maker.id, taker.id, terms.side, terms.qty, terms.px, JSON.stringify(terms), now(), now());
        setMeta(db, "test_trade_id", terms.id);
      })();
      return this.postTrade(terms.id, 0);
    }
    const t = db.prepare("SELECT * FROM trades WHERE trade_id = ?").get(testId) as ProbeTrade & { terms: string; status: string };
    if (this.d.foldTest && t.status === "posted") return this.testTradeByFold(t);
    const a = resolveProbe(db, t, this.lastPublished());
    const setStatus = (s: string, reason?: string) => db.prepare("UPDATE trades SET status = ?, reason = ?, updated_at = ? WHERE trade_id = ?").run(s, reason ?? null, now(), t.trade_id);
    switch (a.kind) {
      case "resolved-settled":
        setStatus("settled");
        setMeta(db, "test_trade_settled", String(a.sweep));
        ccLog("BOOTSTRAP", { trade: t.trade_id, sweep: a.sweep }, "staging test trade settled: strategy keys may register");
        return null;
      case "repost-same":
      case "wait":
        if (t.status === "planned") return this.postTrade(t.trade_id, 0);
        return { phase: "wait-test-trade", action: "waiting", detail: `staging trade ${t.trade_id}: ${a.why}`, writes: 0 };
      case "resolved-void":
        setStatus("void", a.reason);
        if (a.retrySameId) return this.postTrade(t.trade_id, a.sweep);
        return this.stop("manual", `staging trade ${t.trade_id} void:${a.reason} at sweep ${a.sweep}: investigate before registering strategy keys`, "wait-test-trade");
      case "query-repost":
        return this.postTrade(t.trade_id, this.lastPublished());
      case "resolved-never-settled":
        setStatus("never-settled");
        return this.stop("manual", `staging trade ${t.trade_id} never settled (void:expired at ${a.sweep}): investigate`, "wait-test-trade");
      case "ambiguous":
        return this.stop("ambiguous_operation", `staging trade ${t.trade_id}: ${a.why}`, "wait-test-trade");
    }
    return null;
  }

  /**
   * Settle the posted staging trade by evidence, read only: the journal's CONFIRMED POST located in our room (seq +
   * server stamp), the sweep that stamp falls in published (price + flow), the seq outside every missed range, then
   * the official fold at that sweep's ref/close. The referee's lists are a cross-check: listed against the fold = halt.
   * Nothing is re-posted from here. null = settled.
   */
  private async testTradeByFold(t: ProbeTrade & { terms: string }): Promise<StepResult | null> {
    const { db, room } = this.d;
    const wait = (detail: string): StepResult => ({ phase: "wait-test-trade", action: "waiting", detail: `staging trade ${t.trade_id}: ${detail}`, writes: 0 });
    const terms = JSON.parse(t.terms) as Terms;
    const att = db.prepare("SELECT * FROM write_attempts WHERE op_key LIKE ? AND state = 'CONFIRMED' ORDER BY created_at, rowid LIMIT 1")
      .get(`trade:${t.trade_id}:%`) as AttemptRow | undefined;
    if (!att) return wait("no CONFIRMED POST in the journal yet");
    const at = await this.d.journal.locate(att);
    if (!at?.ts) {
      if (this.lastPublished() > terms.until) return this.stop("manual", `staging trade ${t.trade_id}: POST ${att.op_key} CONFIRMED but not found in ${room}, and until ${terms.until} has passed: investigate`, "wait-test-trade");
      return wait(`POST ${att.op_key} CONFIRMED; not located in ${room} yet`);
    }
    const n = sweepForTime(this.d.contest, Date.parse(at.ts));
    const row = db.prepare("SELECT ref_px, applied, flow_json FROM sweeps WHERE n = ?").get(n) as { ref_px: string | null; applied: string | null; flow_json: string | null } | undefined;
    if (!row?.flow_json || !row.ref_px) return wait(`#${at.seq} stamped ${at.ts} -> sweep ${n}: waiting for sweep ${n}'s price and flow posts`);
    const missed = ((JSON.parse(row.flow_json) as { missed?: [string, number, number][] }).missed ?? []);
    if (missed.some(([r, a, b]) => r === room && at.seq >= a && at.seq <= b)) {
      return this.stop("manual", `staging trade ${t.trade_id} #${at.seq} is inside a range the referee missed at sweep ${n}: it was not read; investigate`, "wait-test-trade");
    }
    const ref = row.applied ?? (db.prepare("SELECT ref_px FROM sweeps WHERE n = ?").get(n - 1) as { ref_px: string | null } | undefined)?.ref_px;
    if (!ref) return wait(`no reference price for sweep ${n} yet`);
    const maker = getKey(db, t.maker_id);
    const taker = getKey(db, t.taker_id);
    const late = [maker, taker].filter((k) => !k.minted || k.minted_sweep === null || k.minted_sweep >= n);
    if (late.length) return this.stop("manual", `staging trade ${t.trade_id} stamped for sweep ${n}, but ${late.map((k) => `${k.id} minted at ${k.minted_sweep}`).join(", ")}: investigate`, "wait-test-trade");
    const wire: WireTrade = { id: terms.id, maker: terms.maker, side: terms.side, qty: terms.qty, px: terms.px, taker: terms.taker, until: terms.until, countersigner: taker.did };
    const res = await this.d.foldTest!({ sweep: n, ref, close: row.ref_px, owners: [maker.did, taker.did], trade: wire });
    const listedSettled = db.prepare("SELECT n FROM settled_ids WHERE id = ?").get(t.trade_id) as { n: number } | undefined;
    const listedVoid = db.prepare("SELECT n, reason FROM void_ids WHERE id = ? AND reason <> 'settled' ORDER BY n LIMIT 1").get(t.trade_id) as { n: number; reason: string } | undefined;
    const accounts = Object.fromEntries([maker, taker].map((k) => [k.id, res.accounts[k.did] ?? null]));
    const evidence = { trade_id: t.trade_id, op: att.op_key, nonce: att.nonce, seq: at.seq, stamped_at: at.ts, sweep: n,
      boundary: new Date(sweepTime(this.d.contest, n)).toISOString(), ref, close: row.ref_px, fold: res.reason ? `${res.outcome}:${res.reason}` : res.outcome,
      referee_list: listedSettled ? `settled@${listedSettled.n}` : listedVoid ? `void:${listedVoid.reason}@${listedVoid.n}` : "unlisted", accounts };
    setMeta(db, "test_trade_evidence", JSON.stringify(evidence));
    ccLog("BOOTSTRAP", { trade: t.trade_id, sweep: n, seq: at.seq, stamped_at: at.ts, ref, close: row.ref_px, fold: evidence.fold, referee_list: evidence.referee_list,
      positions: Object.entries(accounts).map(([id, a]) => `${id}:${a?.position ?? "?"}`).join(" ") }, "staging trade resolved by the official fold");
    const setStatus = (s: string, reason?: string) => db.prepare("UPDATE trades SET status = ?, reason = ?, updated_at = ? WHERE trade_id = ?").run(s, reason ?? null, now(), t.trade_id);
    if (res.outcome === "settled" && listedVoid) return this.stop("reconcile_mismatch", `staging trade ${t.trade_id}: fold settled, referee listed void:${listedVoid.reason} at ${listedVoid.n}`, "wait-test-trade");
    if (res.outcome === "void" && listedSettled) return this.stop("reconcile_mismatch", `staging trade ${t.trade_id}: fold void:${res.reason}, referee listed it settled at ${listedSettled.n}`, "wait-test-trade");
    if (res.outcome === "void") {
      setStatus("void", res.reason ?? undefined);
      return this.stop("manual", `staging trade ${t.trade_id} void:${res.reason} at sweep ${n} (official fold): investigate before registering strategy keys`, "wait-test-trade");
    }
    setStatus("settled");
    setMeta(db, "test_trade_settled", String(n));
    ccLog("BOOTSTRAP", { trade: t.trade_id, sweep: n }, "staging test trade settled: strategy keys may register");
    return null;
  }

  /** Sign (once) and post the staging trade. A repost after a void or `until` uses a new op key but the SAME signed trade text. */
  private async postTrade(tradeId: string, repostTag: number): Promise<StepResult> {
    const db = this.d.db;
    const t = db.prepare("SELECT * FROM trades WHERE trade_id = ?").get(tradeId) as { terms: string; maker_id: string; taker_id: string; evidence: string | null };
    let text = t.evidence ? (JSON.parse(t.evidence) as { text: string }).text : null;
    if (!text) {
      text = buildSignedTrade(this.d.signers.get(t.maker_id)!, this.d.signers.get(t.taker_id)!, JSON.parse(t.terms) as Terms).text;
      db.prepare("UPDATE trades SET evidence = ?, status = 'signed', updated_at = ? WHERE trade_id = ?").run(JSON.stringify({ text }), now(), tradeId);
    }
    const w = await this.write({ opKey: `trade:${tradeId}:${repostTag}`, kind: "trade", signerId: t.maker_id, room: this.d.room, text }, "test-trade");
    if (!("attempt_id" in w)) return w;
    db.prepare("UPDATE trades SET status = 'posted', updated_at = ? WHERE trade_id = ?").run(now(), tradeId);
    return { phase: "test-trade", action: "wrote", detail: `staging trade ${tradeId} (${TEST_QTY}) posted in ${this.d.room}${repostTag ? ` (repost after sweep ${repostTag})` : ""}`, writes: 1 };
  }
}

/**
 * Keeps our room alive and ours while the live service runs (every call is cheap; call ~every minute):
 *   - room-owners must still be CC-ADMIN and room-allow exactly our DIDs, and the room must still exist
 *     (technocore.chat deletes rooms/notes idle for 7 days): otherwise a GRAVE room_ownership halt.
 *     It never re-claims or recreates anything by itself.
 *   - every `refreshDays` (default 5): re-sign both notes with their CURRENT values (read first).
 *   - if nothing was written in the room for `keepaliveHours` (default 48): CC-ADMIN posts a plain-text
 *     keepalive (not JSON, so the referee ignores it) so the room never reaches the 7-day idle deletion.
 */
/** Persist our room's generation the first time we see it; afterwards any change is a grave problem (null = fine). */
export function checkGeneration(db: CcDb, room: string, generation: number | undefined, lastSeq?: number): string | null {
  // generation 0 = the name never held a message: nothing to pin yet (our first messages create generation 1)
  if (generation === undefined || generation === 0 || lastSeq === 0) return null;
  const stored = getMeta(db, `room_generation:${room}`);
  if (stored === null) { setMeta(db, `room_generation:${room}`, String(generation)); return null; }
  return Number(stored) === generation ? null : `${room} generation changed ${stored} -> ${generation}: deleted and recreated, it is not our registered room any more. NOT re-registering automatically`;
}

export class RoomKeeper {
  constructor(private d: Pick<BootstrapDeps, "db" | "journal" | "transport" | "room" | "clock" | "pace" | "sleep"> & { refreshDays?: number; keepaliveHours?: number; lockMs?: number }) {}

  async tick(): Promise<{ ok: boolean; detail: string; wrote: number }> {
    const { db, room, transport } = this.d;
    const admin = keysByRole(db, "admin")[0];
    if (!admin) return { ok: false, detail: "no admin key", wrote: 0 };
    const ours = [...keysByRole(db, "staging"), ...keysByRole(db, "strategy")];
    const mustBeAllowed = ours.filter((k) => k.status !== "GENERATED").map((k) => k.did);
    const ourDids = new Set(ours.map((k) => k.did));
    const bad = (why: string) => { halt(db, "room_ownership", why); setMeta(db, "room_health", JSON.stringify({ ok: false, why, at: now() })); return { ok: false, detail: why, wrote: 0 }; };
    const ownerNote = await transport.readNote("room-owners", room);
    if (ownerNote !== admin.did) return bad(ownerNote === null ? `room-owners/${room} is gone (room deleted?): NOT re-claiming automatically` : `room-owners/${room} holds ${ownerNote}, not CC-ADMIN`);
    const allow = await transport.readNote("room-allow", room);
    const got = new Set((allow ?? "").split(/\s+/).filter(Boolean));
    if (mustBeAllowed.some((d) => !got.has(d)) || [...got].some((d) => !ourDids.has(d))) {
      return bad(`room-allow/${room} no longer matches our keys (${got.size} DIDs)`);
    }
    setMeta(db, "room_allow_seen", JSON.stringify([...got]));
    const view = await transport.readRoom(room, 0);
    if (view.last_seq === 0) return bad(`${room} has no messages any more (deleted by technocore.chat?)`);
    // The room's epoch: a deleted-and-recreated room is a DIFFERENT room for the referee (unregistered).
    const gen = checkGeneration(db, room, view.generation, view.last_seq);
    if (gen) return bad(gen);
    let wrote = 0;
    const nowMs = this.d.clock();
    if (this.d.lockMs !== undefined && nowMs >= this.d.lockMs) {
      setMeta(db, "room_health", JSON.stringify({ ok: true, at: now(), last_seq: view.last_seq, note: "after the lock: checks only, no writes" }));
      return { ok: true, detail: "after the lock: no writes", wrote: 0 };
    }
    const last = getMeta(db, "room_refresh_at") ?? getMeta(db, "bootstrap_done_at");
    if (!last || nowMs - Date.parse(last) >= (this.d.refreshDays ?? 5) * 86_400_000) {
      const cycle = Math.floor(nowMs / 86_400_000);
      for (const w of [
        { opKey: `refresh:${room}:${cycle}:owners`, kind: "note-owners" as const, signerId: admin.id, room, value: admin.did, ifValue: admin.did },
        { opKey: `refresh:${room}:${cycle}:allow`, kind: "note-allow" as const, signerId: admin.id, room, value: allow! },
      ]) {
        const r = await journaledWrite(this.d, w, "refresh");
        if ("blocked" in r) return { ok: true, detail: `upkeep skipped: ${r.blocked}`, wrote };
        if ("halted" in r) return { ok: false, detail: r.halted, wrote };
        wrote++;
      }
      setMeta(db, "room_refresh_at", new Date(nowMs).toISOString());
    }
    const lastMsg = await this.lastMessageTs(view.last_seq);
    if (lastMsg !== null && nowMs - lastMsg >= (this.d.keepaliveHours ?? 48) * 3_600_000) {
      const stamp = new Date(nowMs).toISOString();
      const r = await journaledWrite(this.d, { opKey: `keepalive:${room}:${stamp.slice(0, 13)}`, kind: "keepalive", signerId: admin.id, room, text: `close-call keepalive ${stamp}` }, "keepalive");
      if ("blocked" in r) return { ok: true, detail: `upkeep skipped: ${r.blocked}`, wrote };
      if ("halted" in r) return { ok: false, detail: r.halted, wrote };
      wrote++;
    }
    setMeta(db, "room_health", JSON.stringify({ ok: true, at: now(), last_seq: view.last_seq }));
    return { ok: true, detail: `owner + allow-list ours, ${view.last_seq} messages`, wrote };
  }

  private async lastMessageTs(lastSeq: number): Promise<number | null> {
    const tail = await this.d.transport.readRoom(this.d.room, Math.max(0, lastSeq - 1));
    const ts = tail.messages.at(-1)?.ts;
    return ts ? Date.parse(ts) : null;
  }
}
