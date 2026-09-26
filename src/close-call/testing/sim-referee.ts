/**
 * A simulated close-1 referee over MockTechnocore, for tests and `bootstrap --dry-run` only.
 * It applies the published rules (close-call-game.md) closely enough to exercise the bootstrap:
 *
 *   - a sweep reads close1 and every listed room, messages stamped up to the boundary; a listed
 *     room counts only for messages stamped after the sweep that listed it;
 *   - mints first: {"t":"owner"} signed by the key it names, once per key;
 *   - then rooms: {"t":"room"} from an owner (including one minted in this same sweep);
 *   - then trades: both signatures verify, both keys are owners, price within the limits,
 *     until >= n, id not settled yet -> settled, otherwise void with a reason;
 *   - posts `price` and `flow` through the observer's own ingest path, like the real referee.
 *
 * Options mimic what we saw live: `listMints: false` (the 4,096-char cap omits mints),
 * `missSeqs` (a range the referee reports as missed and never reads).
 * It is NOT the official fold; money is not modelled. The official fold is tested elsewhere.
 */

import { verifyEd25519 } from "../../identity.js";
import { sweepTime, type Contest } from "../contest.js";
import { ceilTo, CENT, floorTo, fmt2, mul, toMicro } from "../decimal.js";
import { RefereeObserver } from "../observer.js";
import { makerSigningString, REFEREE_DID, takerSigningString, type Terms } from "../protocol.js";
import type { CcDb } from "../store.js";
import type { MockTechnocore } from "./mock-technocore.js";

export interface SimRefereeOptions { listMints?: boolean; listSettled?: boolean; ref?: string; ageS?: number; missSeqs?: { room: string; from: number; to: number }[] }

export class SimReferee {
  owners = new Set<string>();
  listed = new Map<string, number>([["close1", 0]]);
  settled = new Set<string>();
  private read = new Map<string, number>();
  private postSeq: Record<string, number> = {};
  private observer: RefereeObserver;

  constructor(private db: CcDb, private srv: MockTechnocore, private contest: Contest, public opts: SimRefereeOptions = {}) {
    this.observer = new RefereeObserver(db, "http://unused.invalid", null);
  }

  private post(room: string, body: Record<string, unknown>, tsMs: number) {
    this.postSeq[room] = (this.postSeq[room] ?? 0) + 1;
    this.observer.ingest(room, 1, { seq: this.postSeq[room], ts: new Date(tsMs).toISOString(), from: REFEREE_DID, text: JSON.stringify(body) });
  }

  /** Other players' owners (the real count is ~1.2M): only our growth is simulated on top. */
  baseOwners = 1_000_000;

  /** The contest seed (the engine needs it to start its book). */
  seed(px = "226.00"): void {
    this.post("d-close1-price", { t: "seed", season: "close-1", price: px, trade: { tid: 1, time: new Date(this.contest.openingMs - 1000).toISOString() }, package: "sim", rooms: ["close1"] }, this.contest.openingMs);
  }

  /** Publish a state post for sweep n with no activity (the sweep before the simulation starts). */
  baseline(n: number): void {
    this.post("d-close1-state", { t: "state", n, root: `sim-root-${n}`, owners: this.baseOwners + this.owners.size, rooms: this.listed.size, file: `sim-${n}` }, sweepTime(this.contest, n) + 3_000);
  }

  /** Run sweep n and publish it (the publication time is `publishMs`, default boundary + 3 s). */
  sweep(n: number, publishMs = sweepTime(this.contest, n) + 3_000): { mints: string[]; rooms: string[]; settled: string[]; void: [string, string][] } {
    const boundary = sweepTime(this.contest, n);
    const ref = this.opts.ref ?? "225.00";
    const window = 50_000n;                                          // 5%
    const lo = ceilTo(mul(toMicro(ref), 1_000_000n - window), CENT);
    const hi = floorTo(mul(toMicro(ref), 1_000_000n + window), CENT);
    type M = { room: string; seq: number; from: string; text: string; tsMs: number };
    const batch: M[] = [];
    for (const [room, listedAt] of this.listed) {
      const since = this.read.get(room) ?? 0;
      const msgs = (this.srv.rooms.get(room) ?? []).filter((m) => m.seq > since && Date.parse(m.ts!) <= boundary);
      for (const m of msgs) {
        this.read.set(room, m.seq);
        if (listedAt > 0 && Date.parse(m.ts!) <= sweepTime(this.contest, listedAt)) continue;
        if (this.opts.missSeqs?.some((r) => r.room === room && m.seq >= r.from && m.seq <= r.to)) continue;
        batch.push({ room, seq: m.seq, from: m.from, text: m.text, tsMs: Date.parse(m.ts!) });
      }
    }
    batch.sort((a, b) => a.tsMs - b.tsMs || a.room.localeCompare(b.room) || a.seq - b.seq);
    const parsed = batch.map((m) => { try { return { m, o: JSON.parse(m.text) as Record<string, unknown> }; } catch { return null; } }).filter((x) => x && x.o.season === "close-1") as { m: M; o: Record<string, unknown> }[];
    const mints: string[] = [];
    for (const { m, o } of parsed) if (o.t === "owner" && o.key === m.from && !this.owners.has(m.from)) { this.owners.add(m.from); mints.push(m.from); }
    const rooms: string[] = [];
    for (const { m, o } of parsed) {
      if (o.t === "room" && typeof o.room === "string" && this.owners.has(m.from) && !this.listed.has(o.room) && !o.room.startsWith("d-close1")) {
        this.listed.set(o.room, n);
        rooms.push(o.room);
      }
    }
    const settled: string[] = [];
    const voids: [string, string][] = [];
    for (const { o } of parsed) {
      if (o.t !== "trade") continue;
      const terms = o.terms as Terms;
      const taker = o.taker as string;
      const id = terms?.id;
      if (!id) continue;
      if (this.settled.has(id)) { voids.push([id, "settled"]); continue; }
      if (!verifyEd25519(terms.maker, o.maker_sig as string, makerSigningString(terms))
        || !verifyEd25519(taker, o.taker_sig as string, takerSigningString(terms, taker))) { voids.push([id, "signature"]); continue; }
      if (!this.owners.has(terms.maker) || !this.owners.has(taker)) { voids.push([id, "not_owner"]); continue; }
      if (terms.until < n) { voids.push([id, "expired"]); continue; }
      const px = toMicro(terms.px);
      if (px < lo || px > hi) { voids.push([id, "limits"]); continue; }
      this.settled.add(id);
      settled.push(id);
    }
    const file = `sim-${n}`;
    this.post("d-close1-price", { t: "price", n, ref: { px: ref, tid: n, time: new Date(boundary - 1_000).toISOString() }, limits: [fmt2(lo), fmt2(hi)], global: ref, file,
      ...(this.opts.ageS !== undefined ? { age_s: this.opts.ageS } : {}) }, publishMs);
    const missed = (this.opts.missSeqs ?? []).map((r) => [r.room, r.from, r.to]);
    const hideSettled = this.opts.listSettled === false;
    this.post("d-close1-flow", { t: "flow", n, mints: this.opts.listMints === false ? [] : mints, rooms, settled: hideSettled ? [] : settled, void: voids, missed, file,
      omitted: { ...(this.opts.listMints === false && mints.length ? { mints: mints.length } : {}), ...(hideSettled && settled.length ? { settled: settled.length } : {}) } }, publishMs);
    this.post("d-close1-state", { t: "state", n, root: `sim-root-${n}`, owners: this.baseOwners + this.owners.size, rooms: this.listed.size, file }, publishMs);
    return { mints, rooms, settled, void: voids };
  }
}
