/**
 * Safe mode. Execution (anything that would produce an intent or a write) stops
 * while any halt is active; the observer keeps running regardless.
 *
 * Two severities:
 *   transient  the condition is re-evaluated every tick and the halt clears itself
 *              when it resolves (referee/Hyperliquid stale, disk low);
 *   grave      stays until an operator clears it by hand with the code shown in
 *              `closecall:status` (`closecall:unhalt --code <code>`): reconciliation
 *              mismatch, DB corruption, room ownership inconsistency, unrecoverable
 *              nonce conflict, an operation whose state cannot be resolved.
 *
 * Stored in meta `halts` as {kind: Halt}, so every process (CLI, service) sees it.
 */

import { createHash } from "node:crypto";
import type { Alerts } from "./alerts.js";
import { ccLog } from "./logger.js";
import { getMeta, healthEvent, now, setMeta, type CcDb } from "./store.js";

export type HaltKind =
  | "reconcile_mismatch" | "db_corruption" | "room_ownership" | "nonce_conflict" | "ambiguous_operation"
  | "referee_stale" | "hyperliquid_stale" | "disk_low" | "manual"
  /** A live POST whose fate is not known yet: no new entries until it is resolved by evidence (then it clears itself). */
  | "unknown_trade";

export const GRAVE: readonly HaltKind[] = ["reconcile_mismatch", "db_corruption", "room_ownership", "nonce_conflict", "ambiguous_operation", "manual"];

export interface Halt { kind: HaltKind; severity: "transient" | "grave"; reason: string; code: string; at: string }

export function activeHalts(db: CcDb): Record<string, Halt> {
  const raw = getMeta(db, "halts");
  const halts = raw ? (JSON.parse(raw) as Record<string, Halt>) : {};
  const legacy = getMeta(db, "paper_halted");               // before v2, paper halts lived here
  if (legacy && !halts.reconcile_mismatch) {
    halts.reconcile_mismatch = { kind: "reconcile_mismatch", severity: "grave", reason: legacy, code: codeFor(legacy, "legacy"), at: "legacy" };
  }
  return halts;
}

export function isHalted(db: CcDb): boolean {
  return Object.keys(activeHalts(db)).length > 0;
}

export function haltSummary(db: CcDb): string | null {
  const h = Object.values(activeHalts(db));
  return h.length ? h.map((x) => `HALTED: ${x.kind}: ${x.reason}${x.severity === "grave" ? ` (manual: unhalt --code ${x.code})` : ""}`).join(" | ") : null;
}

function codeFor(reason: string, at: string): string {
  return createHash("sha256").update(`${reason}|${at}`).digest("hex").slice(0, 8);
}

export function halt(db: CcDb, kind: HaltKind, reason: string, alerts?: Alerts): Halt {
  const halts = activeHalts(db);
  if (halts[kind]) return halts[kind];
  const at = now();
  const h: Halt = { kind, severity: GRAVE.includes(kind) ? "grave" : "transient", reason, code: codeFor(reason, at), at };
  halts[kind] = h;
  setMeta(db, "halts", JSON.stringify(halts));
  healthEvent(db, "halt", h);
  ccLog("HALT", { kind, severity: h.severity, code: h.code }, `HALTED: ${reason}`);
  if (alerts) void alerts.raise({ event: "execution_halted", severity: h.severity === "grave" ? "critical" : "warning", message: `HALTED: ${kind}: ${reason}`, key: kind });
  else {
    // No alert sink in this code path (executor, bootstrap, keeper): still record it where monitor and alerts read.
    try {
      db.prepare("INSERT INTO alerts (event, severity, message, detail, delivered, at) VALUES ('execution_halted', ?, ?, ?, 'log', ?)")
        .run(h.severity === "grave" ? "critical" : "warning", `HALTED: ${kind}: ${reason}`, JSON.stringify({ code: h.code }), at);
    } catch { /* read-only DB */ }
  }
  return h;
}

/** Clear a transient halt whose condition has resolved. Refuses grave halts. */
export function clearTransient(db: CcDb, kind: HaltKind, alerts?: Alerts): boolean {
  const halts = activeHalts(db);
  const h = halts[kind];
  if (!h || h.severity !== "transient") return false;
  delete halts[kind];
  setMeta(db, "halts", JSON.stringify(halts));
  healthEvent(db, "resume", { kind });
  ccLog("SAFE MODE", { kind }, "transient halt cleared: condition resolved");
  void alerts?.raise({ event: "execution_resumed", severity: "info", message: `resumed after ${kind}`, key: kind });
  return true;
}

/** Manual recovery for grave halts: the operator must quote the halt's code. */
export function unhalt(db: CcDb, code: string): Halt | null {
  const halts = activeHalts(db);
  const entry = Object.entries(halts).find(([, h]) => h.code === code);
  if (!entry) return null;
  delete halts[entry[0]];
  setMeta(db, "halts", JSON.stringify(halts));
  if (entry[0] === "reconcile_mismatch") setMeta(db, "paper_halted", "");
  healthEvent(db, "unhalt", { kind: entry[0], code });
  ccLog("SAFE MODE", { kind: entry[0], code }, "halt cleared manually");
  return entry[1];
}

// ------------------------------------------------------------------ live writer arming / kill switch

import { existsSync as _exists, readFileSync as _read, unlinkSync as _unlink, writeFileSync as _write } from "node:fs";
import { join as _join } from "node:path";

export const DISARM_FILE = "DISARM";

/**
 * May the live writer send anything right now? The code is always connected; it is ARMED only when
 * CLOSECALL_MODE=live (+ ack), CLOSECALL_LIVE_WRITER=armed, and no DISARM kill-switch file exists in the
 * live data dir. Disarming stops every write (trades, bootstrap, room upkeep) and every new decision;
 * the observer, reconciliation and read-only recovery keep running.
 */
export function writerState(cfg: { mode: string; liveWriter: string; dataDir: string }): { armed: boolean; reason: string } {
  if (cfg.mode !== "live") return { armed: false, reason: `mode ${cfg.mode}` };
  if (cfg.liveWriter !== "armed") return { armed: false, reason: "CLOSECALL_LIVE_WRITER=disarmed" };
  const f = _join(cfg.dataDir, DISARM_FILE);
  if (_exists(f)) {
    let why = "";
    try { why = _read(f, "utf8").trim(); } catch { /* unreadable: still disarmed */ }
    return { armed: false, reason: `kill switch ${f}${why ? `: ${why}` : ""}` };
  }
  return { armed: true, reason: "armed" };
}

export function disarm(dataDir: string, reason: string): void {
  _write(_join(dataDir, DISARM_FILE), `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
}

export function rearm(dataDir: string): boolean {
  const f = _join(dataDir, DISARM_FILE);
  if (!_exists(f)) return false;
  _unlink(f);
  return true;
}

export class WriterDisarmed extends Error {}
