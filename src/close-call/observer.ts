/**
 * Read-only observer of the five referee rooms (GET only; no other HTTP method is
 * reachable from this file).
 *
 * Per room it keeps a `since` cursor in SQLite, reads forward in pages of 200,
 * detects ring gaps (first_seq > since+1), generation resets, and stores every
 * message verbatim (SQLite raw_posts + raw JSONL) before parsing. Only posts signed
 * by the referee DID in its own rooms are parsed, and only known fields; unknown
 * fields are recorded and logged, never interpreted. Messages from anyone else
 * are counted and ignored.
 *
 * Budget: 5 rooms per tick at the default 10 s = 30 reads/min against the
 * 600/min/IP limit (shared with the other bots on the server). 429 responses back
 * off exponentially (Retry-After honoured).
 */

import { ccLog } from "./logger.js";
import { appendRaw, getCursor, now, setCursor, type CcDb } from "./store.js";
import { parseRefereePost, REFEREE_ROOMS, type FlowPost, type PositionsPost, type PnlPost, type PricePost, type RefereePost, type SeedPost, type StatePost } from "./protocol.js";

export class HttpStatusError extends Error {
  constructor(public status: number, public retryAfterS: number | null, msg: string) { super(msg); }
}

export interface RawMessage { seq: number; ts: string; from: string; text: string; nonce?: string; sig?: string }

export interface ObserverEvent {
  kind: "seed" | "price" | "flow" | "positions" | "pnl" | "state" | "final" | "gap" | "generation";
  room: string;
  n?: number;
  post?: RefereePost;
  detail?: Record<string, unknown>;
}

/** Parse a room JSON reply keeping 19-digit nonces exact (they exceed 2^53). */
export function parseRoomJson(body: string): { room: string; first_seq: number | null; last_seq: number; generation?: number; messages: RawMessage[] } {
  const safe = body.replace(/"nonce":\s*(\d+)/g, '"nonce":"$1"');
  return JSON.parse(safe);
}

export class RefereeObserver {
  ignoredForeign = 0;
  errors = 0;
  timeouts = 0;
  lastOkAt: number | null = null;
  private backoffMs = 0;

  constructor(
    private db: CcDb,
    private baseUrl: string,
    private rawDir: string | null,
    private fetchImpl: typeof fetch = fetch,
    private staleAgeS = 300,
  ) {}

  /** Read every referee room forward from its cursor. Never throws on a single room's failure. */
  async pollOnce(): Promise<ObserverEvent[]> {
    if (this.backoffMs > 0) {
      const wait = this.backoffMs;
      await new Promise((r) => setTimeout(r, wait));
    }
    const events: ObserverEvent[] = [];
    for (const room of REFEREE_ROOMS) {
      try {
        events.push(...(await this.readRoom(room)));
        this.backoffMs = 0;
        this.lastOkAt = Date.now();
      } catch (e) {
        const err = e as Error;
        this.errors++;
        if (err.name === "TimeoutError" || err.name === "AbortError") this.timeouts++;
        if (err instanceof HttpStatusError && err.status === 429) {
          this.backoffMs = Math.min(120_000, Math.max(5_000, (err.retryAfterS ?? 0) * 1000, this.backoffMs * 2));
          ccLog("ERROR", { stage: "observe", room, status: 429, backoff_ms: this.backoffMs });
          break;
        }
        this.backoffMs = Math.min(60_000, Math.max(2_000, this.backoffMs * 2));
        ccLog("ERROR", { stage: "observe", room, error: err.message, backoff_ms: this.backoffMs });
      }
    }
    return events;
  }

  private async get(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const ra = res.headers.get("retry-after");
      throw new HttpStatusError(res.status, ra ? Number(ra) : null, `GET ${url} -> ${res.status}`);
    }
    return res.text();
  }

  async readRoom(room: string): Promise<ObserverEvent[]> {
    const events: ObserverEvent[] = [];
    for (let page = 0; page < 50; page++) {
      const cur = getCursor(this.db, room);
      const since = cur?.last_seq ?? 0;
      const body = await this.get(`${this.baseUrl}/r/${room}?format=json&since=${since}&limit=200`);
      const view = parseRoomJson(body);
      const gen = view.generation ?? null;
      if (cur && cur.generation !== null && gen !== null && gen !== cur.generation) {
        ccLog("GAP", { room, kind: "generation_change", from: cur.generation, to: gen }, "room generation changed: cursor reset");
        events.push({ kind: "generation", room, detail: { from: cur.generation, to: gen } });
        setCursor(this.db, room, 0, gen);
        continue;
      }
      if (since > 0 && view.first_seq !== null && view.first_seq > since + 1) {
        const lost = view.first_seq - since - 1;
        this.db.prepare("INSERT INTO gaps (room, since, first_seq, lost, detected_at) VALUES (?, ?, ?, ?, ?)")
          .run(room, since, view.first_seq, lost, now());
        ccLog("GAP", { room, since, first_seq: view.first_seq, lost }, "ring rotated past our cursor: messages lost");
        events.push({ kind: "gap", room, detail: { since, first_seq: view.first_seq, lost } });
      }
      const msgs = view.messages.filter((m) => m.seq > since);
      for (const m of msgs) events.push(...this.ingest(room, gen ?? 0, m));
      const last = msgs.length ? msgs[msgs.length - 1].seq : since;
      setCursor(this.db, room, Math.max(last, since), gen);
      if (msgs.length < 200) break;
    }
    return events;
  }

  /** Store verbatim, then parse. Exposed for tests and replays. */
  ingest(room: string, generation: number, m: RawMessage): ObserverEvent[] {
    const fetchedAt = now();
    this.db.prepare(`INSERT OR IGNORE INTO raw_posts (room, seq, generation, ts, from_did, text, nonce, sig, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(room, m.seq, generation, m.ts, m.from, m.text, m.nonce ?? null, m.sig ?? null, fetchedAt);
    if (this.rawDir) appendRaw(this.rawDir, { room, generation, fetched_at: fetchedAt, ...m });
    let post: RefereePost | null;
    try {
      post = parseRefereePost(room, m.from, m.text);
    } catch (e) {
      ccLog("ERROR", { stage: "parse", room, seq: m.seq, error: (e as Error).message });
      return [];
    }
    if (!post) {
      this.ignoredForeign++;
      return [];
    }
    if (post.unknown.length) ccLog("OBSERVE", { room, seq: m.seq, t: post.t, unknown_fields: post.unknown }, "new referee fields (stored, not interpreted)");
    return this.apply(room, post, m);
  }

  private upsert(n: number, cols: Record<string, unknown>): void {
    const names = Object.keys(cols);
    this.db.prepare(`INSERT INTO sweeps (n, ${names.join(", ")}, first_seen_at, updated_at) VALUES (?, ${names.map(() => "?").join(", ")}, ?, ?)
      ON CONFLICT(n) DO UPDATE SET ${names.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`)
      .run(n, ...names.map((c) => cols[c] as never), now(), now());
  }

  private apply(room: string, post: RefereePost, m: RawMessage): ObserverEvent[] {
    switch (post.t) {
      case "seed": {
        const s = post as SeedPost;
        this.db.prepare(`INSERT OR REPLACE INTO seed (id, price, tid, time, package, json) VALUES (1, ?, ?, ?, ?, ?)`)
          .run(s.price, String(s.trade.tid), s.trade.time, s.package, m.text);
        ccLog("PRICE", { kind: "seed", price: s.price, tid: s.trade.tid, time: s.trade.time, package: s.package });
        return [{ kind: "seed", room, post }];
      }
      case "price": {
        const p = post as PricePost;
        const prev = this.db.prepare("SELECT ref_px, ref_tid FROM sweeps WHERE n = ?").get(p.n - 1) as { ref_px: string; ref_tid: string } | undefined;
        this.upsert(p.n, {
          ref_px: p.ref.px, ref_tid: String(p.ref.tid), ref_time: p.ref.time, applied: p.applied ?? null,
          lim_lo: p.limits[0], lim_hi: p.limits[1], lim_for: p.for ?? null, age_s: p.age_s ?? null,
          global: p.global, file: p.file, price_json: m.text,
        });
        const refChanged = prev ? prev.ref_px !== p.ref.px : null;
        const sameTrade = prev ? prev.ref_tid === String(p.ref.tid) : false;
        ccLog("SWEEP", { n: p.n, close: p.ref.px, close_time: p.ref.time, close_tid: p.ref.tid, applied_ref: p.applied, prev_close: prev?.ref_px ?? null,
          ref_changed: refChanged, next_limits: p.limits, for: p.for, age_s: p.age_s, global: p.global });
        if ((p.age_s ?? 0) >= this.staleAgeS || sameTrade) {
          ccLog("STALE", { n: p.n, age_s: p.age_s, same_tid_as_previous: sameTrade, close: p.ref.px },
            "referee reused an old Hyperliquid trade: this sweep's fee close and next limits are stale");
        }
        return [{ kind: "price", room, n: p.n, post }];
      }
      case "flow": {
        const f = post as FlowPost;
        this.upsert(f.n, {
          mints_listed: f.mints.length, rooms_new: JSON.stringify(f.rooms), settled_listed: f.settled.length, void_listed: f.void.length,
          omitted: JSON.stringify(f.omitted ?? {}), missed: JSON.stringify(f.missed), flow_json: m.text,
        });
        const ins = this.db.prepare("INSERT OR IGNORE INTO settled_ids (id, n) VALUES (?, ?)");
        for (const id of f.settled) ins.run(id, f.n);
        const vins = this.db.prepare("INSERT OR IGNORE INTO void_ids (id, n, reason) VALUES (?, ?, ?)");
        for (const [id, reason] of f.void) if (typeof id === "string") vins.run(id, f.n, String(reason));
        if (f.missed.length) ccLog("MISSED", { n: f.n, missed: f.missed }, "referee reports message ranges it could not read");
        ccLog("OBSERVE", { room, n: f.n, mints: f.mints.length + (f.omitted?.mints ?? 0), settled: f.settled.length + (f.omitted?.settled ?? 0),
          void: f.void.length + (f.omitted?.void ?? 0), new_rooms: f.rooms, missed: f.missed.length });
        return [{ kind: "flow", room, n: f.n, post }];
      }
      case "positions": {
        const p = post as PositionsPost;
        this.upsert(p.n, { open: p.open, longs: p.longs, shorts: p.shorts, pos_top: JSON.stringify(p.top), positions_json: m.text });
        return [{ kind: "positions", room, n: p.n, post }];
      }
      case "pnl": {
        const p = post as PnlPost;
        this.upsert(p.n, { mark: p.mark, pnl_top: JSON.stringify(p.top), pnl_json: m.text });
        return [{ kind: "pnl", room, n: p.n, post }];
      }
      case "state": {
        const s = post as StatePost;
        this.upsert(s.n, { owners: s.owners, rooms: s.rooms, root: s.root, state_json: m.text });
        return [{ kind: "state", room, n: s.n, post }];
      }
      case "final":
        ccLog("PRICE", { kind: "final", price: post.price }, "referee posted S");
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('final_S', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ price: post.price, trade: (post as { trade?: unknown }).trade ?? null, seen_at: now() }));
        return [{ kind: "final", room, post }];
    }
  }
}
