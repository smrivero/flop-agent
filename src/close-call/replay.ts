/**
 * Engine replay: the REAL decision engine (PaperTrader: Strategy K + CONTRA, pricing, sizing, risk, the official
 * fold) driven by a recorded referee stream, exactly as the live service saw it, with no network and no key:
 *
 *   - every referee post (raw_posts) is ingested through the observer at its own server timestamp, so references,
 *     limits, publication delays and stale periods are the ones the service had;
 *   - sweep n is decided at boundary(n) - decision lead, with the estimate the service RECORDED for n (estimates
 *     table: Hyperliquid before the boundary, or the reference fallback) -- never the close;
 *   - a sweep settles when its price post arrives; paper keys mint at the first settlement, trading starts after.
 *
 * Source DBs are opened read-only (a paper backup, or the live DB while its service runs: `tail` for the shadow).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { loadCloseCallConfig } from "./config.js";
import { sweepTime, type Contest } from "./contest.js";
import { toMicro } from "./decimal.js";
import type { Estimate } from "./estimator.js";
import { OfficialFold } from "./fold.js";
import type { HyperliquidObserver } from "./hyperliquid.js";
import { setQuiet } from "./logger.js";
import { openReadonly } from "./monitor.js";
import { RefereeObserver } from "./observer.js";
import { foldConfig, PaperTrader } from "./paper.js";
import type { PricePost } from "./protocol.js";
import { openCloseCallDb, type CcDb } from "./store.js";

interface RawPost { room: string; seq: number; generation: number; ts: string; from_did: string; text: string; nonce: string | null; sig: string | null }
interface EstRow { n: number; estimated_close: string; used: string; stale: number; hl_px: string | null }

export interface ReplayOptions {
  source: string;                       // DB with raw_posts + estimates (paper backup, or the live DB)
  vendorRoot: string;
  contest: Contest;
  from: number;                         // first sweep decided
  to?: number;                          // last sweep decided (default: the last recorded estimate)
  env: Record<string, string>;          // engine config (CLOSECALL_KEY_COUNT, CLOSECALL_CONTRA_*, ...)
  quiet?: boolean;
  python?: string;
}

export interface Replay {
  trader: PaperTrader;
  db: CcDb;
  decided: number[];
  /** Feed what the source has gained since the last call (tail mode); returns the sweeps decided now. */
  advance(until?: number): Promise<number[]>;
  stop(): void;
}

/** A minimal Hyperliquid view for the engine: the price the service recorded at each decision (divergence input only). */
function hlStub(): HyperliquidObserver & { set(px: string | null): void } {
  let latest: { px: string; tid: string; timeMs: number } | null = null;
  return {
    get latest() { return latest; },
    set(px: string | null) { latest = px ? { px, tid: "replay", timeMs: 0 } : null; },
    ageMs: () => 0, feedAgeMs: () => 0, lastBefore: () => null, hasTid: () => false,
  } as unknown as HyperliquidObserver & { set(px: string | null): void };
}

export async function engineReplay(o: ReplayOptions): Promise<Replay> {
  if (o.quiet !== false) setQuiet(true);
  const dir = mkdtempSync(join(tmpdir(), "closecall-replay-"));
  const cfg = loadCloseCallConfig({ CLOSECALL_VENDOR_ROOT: o.vendorRoot, CLOSECALL_DATA_DIR: dir, CLOSECALL_MODE: "paper", ...o.env });
  const db = openCloseCallDb(join(dir, "replay.sqlite3"));
  const observer = new RefereeObserver(db, "http://unused.invalid", null);
  const main = await OfficialFold.start(o.python ?? cfg.python, o.vendorRoot, foldConfig(o.contest));
  const look = await OfficialFold.start(o.python ?? cfg.python, o.vendorRoot, foldConfig(o.contest));
  const hl = hlStub();
  const trader = new PaperTrader(db, cfg, o.contest, main, look, hl);
  const estimates = new Map<number, EstRow>();
  trader.estimateHook = (n) => {
    const e = estimates.get(n);
    return e ? ({ value: toMicro(e.estimated_close), used: e.used === "ref" ? "ref" : "hl", stale: e.stale === 1, reason: "recorded estimate (replay)" } as Estimate) : null;
  };
  let lastTs = "";
  const seen = new Set<string>();
  let started = false;
  let nextDecision = o.from;
  let lastPriceN = 0;
  const decided: number[] = [];

  const read = (): { posts: RawPost[]; ests: EstRow[] } => {
    const { db: src, error } = openReadonly(o.source);
    if (!src) throw new Error(`cannot open ${o.source} read-only: ${error}`);
    try {
      const posts = src.prepare(`SELECT room, seq, generation, ts, from_did, text, nonce, sig FROM raw_posts WHERE room LIKE 'd-close1-%' AND ts >= ? ORDER BY ts, room, seq`).all(lastTs) as RawPost[];
      const ests = (src as Database.Database).prepare("SELECT n, estimated_close, used, stale, hl_px FROM estimates WHERE estimated_close IS NOT NULL AND n >= ?").all(o.from) as EstRow[];
      return { posts, ests };
    } finally {
      src.close();
    }
  };

  const ingest = async (p: RawPost) => {
    const key = `${p.room}|${p.generation}|${p.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    lastTs = p.ts;
    const events = observer.ingest(p.room, p.generation, { seq: p.seq, ts: p.ts, from: p.from_did, text: p.text, nonce: p.nonce ?? undefined, sig: p.sig ?? undefined });
    for (const ev of events) {
      if (ev.kind !== "price") continue;
      lastPriceN = Math.max(lastPriceN, ev.n!);
      if (started) await trader.settle(ev.n!, ev.post as PricePost);
    }
  };

  const advance = async (until = o.to ?? Number.MAX_SAFE_INTEGER): Promise<number[]> => {
    const { posts, ests } = read();
    for (const e of ests) estimates.set(e.n, e);
    const now: number[] = [];
    let i = 0;
    // History strictly before the window: ingest without settling, then start the engine (paper keys mint at the next price post).
    if (!started) {
      const startAt = sweepTime(o.contest, o.from - 1);
      for (; i < posts.length && Date.parse(posts[i].ts) < startAt; i++) await ingest(posts[i]);
      await trader.start();
      started = true;
    }
    const lead = trader["cfg"].decisionLeadMs as number;
    const lastEst = Math.max(0, ...estimates.keys());
    while (nextDecision <= until && nextDecision <= lastEst) {
      const t = sweepTime(o.contest, nextDecision) - lead;
      for (; i < posts.length && Date.parse(posts[i].ts) <= t; i++) await ingest(posts[i]);
      hl.set(estimates.get(nextDecision)?.hl_px ?? null);
      if (estimates.has(nextDecision)) { await trader.decide(nextDecision, true, t); decided.push(nextDecision); now.push(nextDecision); }
      nextDecision++;
    }
    // Settle what has been published since -- a bounded window stops once its last sweep's price post is in.
    for (; i < posts.length && (until === Number.MAX_SAFE_INTEGER || lastPriceN < until); i++) await ingest(posts[i]);
    return now;
  };

  return { trader, db, decided, advance, stop: () => { main.stop(); look.stop(); } };
}

/** Best-key and champion scores of a replay, valued at `mark` (default: the last close ingested). */
export function replayScores(r: Replay, mark?: string): { mark: string; byKey: Map<string, number>; best: { id: string; score: number } } {
  const m = mark ?? (r.db.prepare("SELECT ref_px FROM sweeps WHERE ref_px IS NOT NULL ORDER BY n DESC LIMIT 1").get() as { ref_px: string }).ref_px;
  const byKey = new Map<string, number>();
  for (const k of r.trader.allKeys()) {
    const a = r.trader.ledger.accounts.get(k.did);
    byKey.set(k.id, a ? Number(a.valueAt(toMicro(m))) / 1e6 - 10_000 : 0);
  }
  let best = { id: "", score: -Infinity };
  for (const [id, s] of byKey) if (s > best.score) best = { id, score: s };
  return { mark: m, byKey, best };
}
