/**
 * Snapshot of everything Close Call knows, read from its SQLite file only (no network).
 * Used by `closecall:status` and by the periodic [CLOSECALL][STATE] log line.
 */

import { keyStatusCounts } from "./keys.js";
import type { CcDb } from "./store.js";
import { getMeta } from "./store.js";

export interface Snapshot {
  sweep: number | null;
  close: string | null;
  close_time: string | null;
  previous_ref: string | null;
  next_limits: [string, string] | null;
  age_s: number | null;
  global: string | null;
  owners: number | null;
  rooms: number | null;
  open_interest: string | null;
  longs: number | null;
  shorts: number | null;
  mark: string | null;
  top3: [string, string][];
  missed_ranges: unknown[];
  gaps: number;
  cursors: Record<string, number>;
  hl_latest: { px: string; tid: string; time: string } | null;
  keys: Record<string, number>;
  paper_intents: { total: number; ok: number; rejected: number; settled: number; void: number; pending: number };
  paper_fees: string | null;
  estimate_error_bps: { n: number; mean_abs: number | null; max_abs: number | null; hl_ref_match: string };
  last_reconcile: { level: string; status: string; n: number | null; at: string }[];
  halted: string | null;
  updated_at: string | null;
}

export function snapshot(db: CcDb): Snapshot {
  const s = db.prepare("SELECT * FROM sweeps WHERE price_json IS NOT NULL ORDER BY n DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const full = db.prepare("SELECT * FROM sweeps WHERE state_json IS NOT NULL ORDER BY n DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const prev = s ? (db.prepare("SELECT ref_px FROM sweeps WHERE n = ?").get((s.n as number) - 1) as { ref_px: string } | undefined) : undefined;
  const missed = (db.prepare("SELECT n, missed FROM sweeps WHERE missed IS NOT NULL AND missed != '[]'").all() as { n: number; missed: string }[])
    .map((r) => ({ n: r.n, ranges: JSON.parse(r.missed) }));
  const cursors = Object.fromEntries((db.prepare("SELECT room, last_seq FROM cursors").all() as { room: string; last_seq: number }[]).map((r) => [r.room, r.last_seq]));
  const hl = db.prepare("SELECT tid, px, time_ms FROM hl_trades ORDER BY time_ms DESC LIMIT 1").get() as { tid: string; px: string; time_ms: number } | undefined;
  const it = db.prepare(`SELECT COUNT(*) total, SUM(risk_status='OK') ok, SUM(risk_status='REJECTED') rejected, SUM(outcome='settled') settled,
    SUM(outcome='void') void, SUM(risk_status='OK' AND outcome IS NULL) pending FROM intents`).get() as Record<string, number | null>;
  const est = db.prepare(`SELECT COUNT(*) n, AVG(ABS(error_bps)) mean_abs, MAX(ABS(error_bps)) max_abs, SUM(hl_matches_ref = 1) m, SUM(hl_matches_ref IS NOT NULL) k
    FROM estimates WHERE actual_close IS NOT NULL`).get() as Record<string, number | null>;
  const lastPaper = db.prepare("SELECT fold_result FROM paper_sweeps ORDER BY n DESC LIMIT 1").get() as { fold_result: string } | undefined;
  void lastPaper;
  const fees = db.prepare("SELECT SUM(CAST(actual_maker_fee AS REAL) + CAST(actual_taker_fee AS REAL)) f FROM intents WHERE outcome = 'settled'").get() as { f: number | null };
  const recon = db.prepare(`SELECT level, status, n, at FROM reconcile WHERE id IN (SELECT MAX(id) FROM reconcile GROUP BY level) ORDER BY level`).all() as Snapshot["last_reconcile"];
  return {
    sweep: (s?.n as number) ?? null,
    close: (s?.ref_px as string) ?? null,
    close_time: (s?.ref_time as string) ?? null,
    previous_ref: prev?.ref_px ?? null,
    next_limits: s?.lim_lo ? [s.lim_lo as string, s.lim_hi as string] : null,
    age_s: (s?.age_s as number) ?? null,
    global: (s?.global as string) ?? null,
    owners: (full?.owners as number) ?? null,
    rooms: (full?.rooms as number) ?? null,
    open_interest: (full?.open as string) ?? null,
    longs: (full?.longs as number) ?? null,
    shorts: (full?.shorts as number) ?? null,
    mark: (full?.mark as string) ?? null,
    top3: full?.pnl_top ? (JSON.parse(full.pnl_top as string) as [string, string][]).slice(0, 3) : [],
    missed_ranges: missed,
    gaps: (db.prepare("SELECT COUNT(*) n FROM gaps").get() as { n: number }).n,
    cursors,
    hl_latest: hl ? { px: hl.px, tid: hl.tid, time: new Date(hl.time_ms).toISOString() } : null,
    keys: keyStatusCounts(db),
    paper_intents: { total: it.total ?? 0, ok: it.ok ?? 0, rejected: it.rejected ?? 0, settled: it.settled ?? 0, void: it.void ?? 0, pending: it.pending ?? 0 },
    paper_fees: fees.f === null ? null : fees.f.toFixed(4),
    estimate_error_bps: { n: est.n ?? 0, mean_abs: est.mean_abs, max_abs: est.max_abs, hl_ref_match: `${est.m ?? 0}/${est.k ?? 0}` },
    last_reconcile: recon,
    halted: getMeta(db, "paper_halted"),
    updated_at: (s?.updated_at as string) ?? null,
  };
}
