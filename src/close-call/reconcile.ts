/**
 * Reconciliation.
 *
 * L1 (referee, every sweep): the five posts of sweep n must agree with each other and with
 * sweep n-1. Each rule was verified to hold on all 22 sweeps observed on 25 Sep:
 *   posts      all five posts of the sweep are present
 *   file       all five carry the same sweep-record hash
 *   applied    price.applied == price(n-1).ref.px (the seed for n = 1)
 *   limits     price.limits == [ceil(0.95*ref), floor(1.05*ref)] for sweep for == n+1
 *   owners     state.owners(n) - state.owners(n-1) == listed mints + omitted.mints
 *   rooms      NOT a halting check (a note only). The count drops whenever technocore.chat deletes idle
 *              rooms ("a room technocore.chat deletes leaves the list", rules §5; 26 Sep, sweeps 206-297:
 *              153 -> 76 -> 22 ...), and a burst of registrations can exceed what the 4,096-char flow post
 *              lists (sweep 222: +136 with 135 listed). Other players' rooms never touch our books, so an
 *              unexplained change is recorded and logged, never a MISMATCH. It halted paper for 7.5 h once.
 *   global     unchanged when nothing settled
 *   mark       pnl.mark == price.global
 * The state `root` itself cannot be recomputed: its algorithm and the per-sweep files it
 * covers are not public (the flow post only carries the file's hash). That is recorded as
 * a known limit, not as OK.
 *
 * L2 (our books): official fold vs TypeScript mirror, exact, after every paper sweep
 * (paper.ts). Any MISMATCH, L1 or L2, sets paper_halted and stops new intents.
 */

import { limitsFor } from "./protocol.js";
import { fmt2, toMicro } from "./decimal.js";
import { ccLog } from "./logger.js";
import { getMeta, recordReconcile, setMeta, type CcDb } from "./store.js";
import { halt } from "./safety.js";

interface Row {
  n: number; ref_px: string | null; applied: string | null; lim_lo: string | null; lim_hi: string | null; lim_for: number | null;
  global: string | null; file: string | null; mints_listed: number | null; rooms_new: string | null; settled_listed: number | null;
  omitted: string | null; owners: number | null; rooms: number | null; mark: string | null;
  price_json: string | null; flow_json: string | null; positions_json: string | null; pnl_json: string | null; state_json: string | null;
}

export interface L1Result { n: number; status: "OK" | "MISMATCH" | "INCOMPLETE"; failed: string[]; checks: number; notes?: string[] }

function fileOf(json: string | null): string | null {
  if (!json) return null;
  try { return (JSON.parse(json) as { file?: string }).file ?? null; } catch { return null; }
}

export function checkSweep(db: CcDb, n: number, windowMicro = 50_000n): L1Result {
  const row = db.prepare("SELECT * FROM sweeps WHERE n = ?").get(n) as Row | undefined;
  const prev = n > 1 ? (db.prepare("SELECT * FROM sweeps WHERE n = ?").get(n - 1) as Row | undefined) : undefined;
  const seed = db.prepare("SELECT price FROM seed WHERE id = 1").get() as { price: string } | undefined;
  if (!row || !row.price_json || !row.flow_json || !row.positions_json || !row.pnl_json || !row.state_json) {
    return { n, status: "INCOMPLETE", failed: ["posts: not all five posts seen yet"], checks: 0 };
  }
  if (n > 1 && (!prev || !prev.state_json || !prev.price_json)) {
    return { n, status: "INCOMPLETE", failed: [`previous sweep ${n - 1} not fully observed`], checks: 0 };
  }
  const failed: string[] = [];
  const notes: string[] = [];
  let checks = 0;
  const check = (name: string, ok: boolean, detail: string) => { checks++; if (!ok) failed.push(`${name}: ${detail}`); };
  const omitted = JSON.parse(row.omitted ?? "{}") as Record<string, number>;
  const files = new Set([fileOf(row.price_json), fileOf(row.flow_json), fileOf(row.positions_json), fileOf(row.pnl_json), fileOf(row.state_json)]);
  check("file", files.size === 1 && !files.has(null), `${files.size} different file hashes`);
  const prevClose = n === 1 ? seed?.price ?? null : prev!.ref_px;
  check("applied", row.applied === null || prevClose === null || toMicro(row.applied) === toMicro(prevClose), `applied ${row.applied} vs previous close ${prevClose}`);
  if (row.ref_px && row.lim_lo && row.lim_hi) {
    const [lo, hi] = limitsFor(toMicro(row.ref_px), windowMicro);
    check("limits", toMicro(row.lim_lo) === lo && toMicro(row.lim_hi) === hi && (row.lim_for === null || row.lim_for === n + 1),
      `posted ${row.lim_lo}-${row.lim_hi} for ${row.lim_for}, formula ${fmt2(lo)}-${fmt2(hi)} for ${n + 1}`);
  }
  const mints = (row.mints_listed ?? 0) + (omitted.mints ?? 0);
  const prevOwners = n === 1 ? 0 : prev!.owners ?? 0;
  check("owners", row.owners !== null && row.owners - prevOwners === mints, `owners ${prevOwners} -> ${row.owners}, mints ${mints}`);
  const newRooms = (JSON.parse(row.rooms_new ?? "[]") as string[]).length;
  const prevRooms = n === 1 ? 1 : prev!.rooms ?? 0;
  const roomsExpected = prevRooms + newRooms + (omitted.rooms ?? 0);
  if (row.rooms !== null && row.rooms !== roomsExpected) {
    notes.push(`rooms ${prevRooms} -> ${row.rooms}, new ${newRooms}${omitted.rooms ? ` (+${omitted.rooms} omitted)` : ""}: ${row.rooms < roomsExpected ? `${roomsExpected - row.rooms} deleted by technocore.chat` : `${row.rooms - roomsExpected} more than listed`}`);
  }
  const settled = (row.settled_listed ?? 0) + (omitted.settled ?? 0);
  const prevGlobal = n === 1 ? seed?.price ?? null : prev!.global;
  if (settled === 0 && prevGlobal && row.global) check("global", toMicro(row.global) === toMicro(prevGlobal), `no trades but global ${prevGlobal} -> ${row.global}`);
  if (row.mark && row.global) check("mark", toMicro(row.mark) === toMicro(row.global), `mark ${row.mark} vs global ${row.global}`);
  return { n, status: failed.length ? "MISMATCH" : "OK", failed, checks, notes };
}

/** Check every fully observed sweep not yet checked OK; logs and records each result. */
export function reconcileReferee(db: CcDb, opts: { recheck?: boolean; haltOnMismatch?: boolean } = {}): L1Result[] {
  const last = Number(getMeta(db, "l1_checked") ?? "0");
  const ns = (db.prepare("SELECT n FROM sweeps WHERE n > ? ORDER BY n").all(opts.recheck ? 0 : last) as { n: number }[]).map((r) => r.n);
  const out: L1Result[] = [];
  let highest = opts.recheck ? 0 : last;
  for (const n of ns) {
    const r = checkSweep(db, n);
    if (r.status === "INCOMPLETE") {
      if (n === ns.at(-1)) break;           // the newest sweep may still be arriving
      ccLog("GAP", { n, detail: r.failed }, "sweep not fully observed: L1 cannot check it (recorded, not retried)");
      recordReconcile(db, n, "L1-referee", "MISMATCH", { incomplete: r.failed });
      out.push(r);
      highest = n;
      continue;
    }
    out.push(r);
    recordReconcile(db, n, "L1-referee", r.status === "OK" ? "OK" : "MISMATCH", { checks: r.checks, failed: r.failed, notes: r.notes?.length ? r.notes : undefined });
    ccLog(r.status === "OK" ? "RECONCILE OK" : "RECONCILE MISMATCH", { level: "L1 referee", n, checks: r.checks, failed: r.failed.length ? r.failed : undefined, notes: r.notes?.length ? r.notes : undefined });
    highest = n;
    if (r.status === "MISMATCH" && opts.haltOnMismatch !== false) {
      halt(db, "reconcile_mismatch", `L1 referee mismatch at sweep ${n}: ${r.failed.join("; ")}`);
    }
  }
  if (!opts.recheck) setMeta(db, "l1_checked", String(highest));
  return out;
}
