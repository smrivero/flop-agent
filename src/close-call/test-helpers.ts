/** Shared fixtures for close-call tests (not a test file itself). */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCloseCallConfig, type CloseCallConfig } from "./config.js";
import { loadContest, type Contest } from "./contest.js";
import { setQuiet } from "./logger.js";
import { RefereeObserver } from "./observer.js";
import { REFEREE_DID } from "./protocol.js";
import { openCloseCallDb, type CcDb } from "./store.js";

setQuiet(true);

export const VENDOR = resolve(process.cwd(), "vendor/technocore-close-call");

export function tmpDb(): { db: CcDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "closecall-test-"));
  return { db: openCloseCallDb(join(dir, "cc.sqlite3")), dir };
}

export function testConfig(env: Record<string, string> = {}): CloseCallConfig {
  return loadCloseCallConfig({ CLOSECALL_VENDOR_ROOT: VENDOR, ...env });
}

export function contest(): Contest {
  return loadContest(VENDOR);
}

/** Feed referee posts (as the referee would sign them) into the observer's ingest path. */
export class RefereeFeed {
  private seq: Record<string, number> = {};
  readonly observer: RefereeObserver;
  constructor(readonly db: CcDb) {
    this.observer = new RefereeObserver(db, "http://unused.invalid", null);
  }
  post(room: string, body: Record<string, unknown>, from = REFEREE_DID) {
    this.seq[room] = (this.seq[room] ?? 0) + 1;
    return this.observer.ingest(room, 1, { seq: this.seq[room], ts: new Date().toISOString(), from, text: JSON.stringify(body) });
  }
  seed(price = "226.14") {
    return this.post("d-close1-price", { t: "seed", season: "close-1", price, trade: { tid: 1, time: "2026-09-25T11:59:42Z" },
      package: "bae09812e25eb6f1369c611f24964f7ea0acafddfc45301a16f33f941296dafa", rooms: [], limits: ["214.84", "237.44"], for: 1 });
  }
  /** All five posts of sweep n, consistent with each other (L1 holds). */
  sweep(n: number, o: { close: string; applied: string; ageS?: number; owners: number; prevOwners: number; rooms?: number; mints?: number; global?: string; tid?: number }) {
    const file = `f${n}`;
    const ref = Number(o.close);
    const lo = (Math.ceil(ref * 95 - 1e-9) / 100).toFixed(2);
    const hi = (Math.floor(ref * 105 + 1e-9) / 100).toFixed(2);
    const g = o.global ?? "226.14";           // no trades in fixtures: the global price never moves
    const out = [
      ...this.post("d-close1-price", { t: "price", n, ref: { px: o.close, tid: o.tid ?? 1000 + n, time: "2026-09-25T12:00:00Z" }, limits: [lo, hi], global: g, file, applied: o.applied, for: n + 1, age_s: o.ageS ?? 3 }),
      ...this.post("d-close1-flow", { t: "flow", n, mints: [], rooms: [], settled: [], void: [], missed: [], file, omitted: { mints: o.mints ?? o.owners - o.prevOwners } }),
      ...this.post("d-close1-positions", { t: "positions", n, open: "0", longs: 0, shorts: 0, top: [], file }),
      ...this.post("d-close1-pnl", { t: "pnl", n, mark: g, top: [], file }),
      ...this.post("d-close1-state", { t: "state", n, root: "r", owners: o.owners, rooms: o.rooms ?? 1, file }),
    ];
    return out;
  }
}
