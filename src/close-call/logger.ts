/**
 * Two outputs for every event:
 *  - console: one human-readable line, `[CLOSECALL][CATEGORY] ts=... key=value ...`
 *    (journald keeps these when running under systemd);
 *  - disk: one JSON object per line in <dir>/events-YYYY-MM-DD[.N].jsonl with
 *    ts (UTC), level, component, category, message and the fields.
 *
 * Rotation: a new file per UTC day, rolled to .1, .2 ... when a file passes
 * `maxFileBytes`; files older than `retentionDays` are deleted and the directory is
 * kept under `maxTotalBytes` (oldest first).
 *
 * Secrets: any field whose NAME looks like key material (seed, private key,
 * secret, token, password, api key, signature) is replaced by "[redacted]" in both
 * outputs, recursively. Room messages are data, never instructions: nothing here
 * interprets them.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type CloseCallLogCategory =
  | "START" | "MODE" | "CONFIG" | "LOCK" | "FOLD" | "OBSERVE" | "SWEEP" | "PRICE" | "HL" | "STALE" | "GAP" | "MISSED"
  | "STATE" | "LEADERBOARD" | "RECONCILE OK" | "RECONCILE MISMATCH" | "STRATEGY" | "RISK" | "PAPER INTENT" | "PAPER RESULT"
  | "PAPER SUMMARY" | "ESTIMATE" | "KEYS" | "ROOM" | "PROBE" | "EXECUTOR" | "BOOTSTRAP" | "BACKUP" | "HEALTH" | "ALERT" | "HALT" | "SAFE MODE" | "ERROR";

export type Level = "debug" | "info" | "warn" | "error";

const LEVEL: Partial<Record<CloseCallLogCategory, Level>> = {
  ERROR: "error", HALT: "error", "RECONCILE MISMATCH": "error", "SAFE MODE": "error",
  ALERT: "warn", STALE: "warn", GAP: "warn", MISSED: "warn", RISK: "warn",
};

const COMPONENT: Partial<Record<CloseCallLogCategory, string>> = {
  OBSERVE: "observer", SWEEP: "observer", PRICE: "observer", STALE: "observer", GAP: "observer", MISSED: "observer", HL: "hyperliquid",
  STRATEGY: "strategy", RISK: "risk", "PAPER INTENT": "execution", "PAPER RESULT": "execution", "PAPER SUMMARY": "execution",
  EXECUTOR: "execution", PROBE: "execution", ESTIMATE: "estimator", KEYS: "keys", ROOM: "room", FOLD: "fold",
  "RECONCILE OK": "reconcile", "RECONCILE MISMATCH": "reconcile", HEALTH: "health", ALERT: "alerts", HALT: "safety", "SAFE MODE": "safety",
  LOCK: "process", START: "process", MODE: "process", CONFIG: "process", STATE: "state", LEADERBOARD: "state",
};

export const SECRET_FIELD = /(seed|private|secret|passphrase|password|token|api[_-]?key|authorization|^sig$|_sig$|signature)/i;

export interface LogSinkOptions { maxFileBytes?: number; maxTotalBytes?: number; retentionDays?: number }

let sinkDir: string | null = null;
let quiet = false;
let opts: Required<LogSinkOptions> = { maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 500 * 1024 * 1024, retentionDays: 14 };
let lastPrune = 0;

export function setLogSink(dir: string | null, options: LogSinkOptions = {}): void {
  sinkDir = dir;
  opts = { ...opts, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<LogSinkOptions>;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    pruneLogs(dir);
  }
}

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) =>
    [k, SECRET_FIELD.test(k) && v !== null && v !== undefined && v !== "-" ? "[redacted]" : redact(v, depth + 1)]));
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function currentFile(dir: string, day: string): string {
  let i = 0;
  for (;;) {
    const f = join(dir, i === 0 ? `events-${day}.jsonl` : `events-${day}.${i}.jsonl`);
    let size = 0;
    try { size = statSync(f).size; } catch { return f; }
    if (size < opts.maxFileBytes) return f;
    i++;
  }
}

/** Delete event/raw log files past the retention window, then oldest-first until under the size cap. */
export function pruneLogs(dir: string, nowMs = Date.now()): { deleted: string[] } {
  const deleted: string[] = [];
  let files: { f: string; mtime: number; size: number }[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^(events|raw)-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(f))
      .map((f) => { const st = statSync(join(dir, f)); return { f, mtime: st.mtimeMs, size: st.size }; });
  } catch {
    return { deleted };
  }
  files.sort((a, b) => a.mtime - b.mtime);
  const cutoff = nowMs - opts.retentionDays * 86_400_000;
  let total = files.reduce((s, x) => s + x.size, 0);
  for (const x of files) {
    if (x.mtime < cutoff || total > opts.maxTotalBytes) {
      try { unlinkSync(join(dir, x.f)); deleted.push(x.f); total -= x.size; } catch { /* already gone */ }
    }
  }
  return { deleted };
}

export function ccLog(category: CloseCallLogCategory, fields: Record<string, unknown> = {}, message?: string): void {
  const ts = new Date().toISOString();
  const level = LEVEL[category] ?? "info";
  const safe = redact(fields) as Record<string, unknown>;
  const parts = Object.entries(safe).map(([k, v]) => `${k}=${render(v)}`);
  const line = `[CLOSECALL][${category}] ts=${ts}${message ? " " + message : ""}${parts.length ? " " + parts.join(" ") : ""}`;
  if (!quiet) (level === "error" ? process.stderr : process.stdout).write(line + "\n");
  if (sinkDir) {
    appendFileSync(currentFile(sinkDir, ts.slice(0, 10)), JSON.stringify({ ts, level, component: COMPONENT[category] ?? "closecall", category, message, ...safe },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      pruneLogs(sinkDir);
    }
  }
}
