/**
 * READ-ONLY Hyperliquid observer for xyz:NVDA.
 *
 * The only request it can make is the public info query {"type":"recentTrades"}
 * (HTTP POST is how Hyperliquid's read API works; it places nothing). There is no
 * exchange endpoint, wallet or signing anywhere in this module.
 *
 * It keeps every trade it sees (SQLite hl_trades) so that, after each sweep, we can
 * ask "what was the last trade before the boundary?" and compare it with the
 * referee's ref (px, tid, time).
 */

import { ccLog } from "./logger.js";
import type { CcDb } from "./store.js";

export interface HlTrade { px: string; tid: string; timeMs: number }

export class HyperliquidObserver {
  latest: HlTrade | null = null;
  errors = 0;

  constructor(private db: CcDb, private infoUrl: string, private coin: string, private fetchImpl: typeof fetch = fetch) {}

  async pollOnce(nowMs = Date.now()): Promise<HlTrade | null> {
    try {
      const res = await this.fetchImpl(this.infoUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "recentTrades", coin: this.coin }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`recentTrades -> ${res.status}`);
      const body = (await res.text()).replace(/"tid":\s*(\d+)/g, '"tid":"$1"');
      const trades = JSON.parse(body) as { px: string; tid: string; time: number; coin: string }[];
      const ins = this.db.prepare("INSERT OR IGNORE INTO hl_trades (tid, px, time_ms, observed_at_ms) VALUES (?, ?, ?, ?)");
      for (const t of trades) {
        if (t.coin !== this.coin) continue;
        ins.run(String(t.tid), t.px, t.time, nowMs);
        if (!this.latest || t.time > this.latest.timeMs || (t.time === this.latest.timeMs && t.tid > this.latest.tid)) {
          this.latest = { px: t.px, tid: String(t.tid), timeMs: t.time };
        }
      }
      return this.latest;
    } catch (e) {
      this.errors++;
      ccLog("ERROR", { stage: "hyperliquid", error: (e as Error).message, errors: this.errors });
      return this.latest;
    }
  }

  ageMs(nowMs = Date.now()): number | null {
    return this.latest ? nowMs - this.latest.timeMs : null;
  }

  /** Last trade we observed strictly before `boundaryMs` (the referee's rule for a sweep close). */
  lastBefore(boundaryMs: number): HlTrade | null {
    const r = this.db.prepare("SELECT tid, px, time_ms FROM hl_trades WHERE time_ms < ? ORDER BY time_ms DESC, tid DESC LIMIT 1")
      .get(boundaryMs) as { tid: string; px: string; time_ms: number } | undefined;
    return r ? { tid: r.tid, px: r.px, timeMs: r.time_ms } : null;
  }

  hasTid(tid: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM hl_trades WHERE tid = ?").get(tid);
  }
}
