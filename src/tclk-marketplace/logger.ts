/**
 * Structured, grep-friendly logging for the TCLK Marketplace Worker:
 * `[TCLK][<TAG>] k=v k2=v2 ...`, one line per event, per the "MUY detallados"
 * logging requirement. A separate logger from debate/mentions on purpose --
 * this module must never depend on those pipelines, and its own tag namespace
 * (`[TCLK][SCANNER]`, `[TCLK][OFFER]`, ...) is what makes `grep '\[TCLK\]'`
 * on this worker's output complete on its own.
 *
 * SECURITY: never pass a raw secret/preimage/seed/private key as a field value.
 * `secretFingerprint` (first 8 hex chars of sha256(secret)) is the only safe way
 * to reference one in a log line -- see fingerprintSecret below. Every call site
 * in this module that touches a secret uses it; nothing here truncates or
 * redacts automatically, because a logger can't tell a secret from any other
 * string -- the discipline is at the call site, same as verifierWorker.ts's own
 * "nothing here logs a preimage" rule.
 */

import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info";

export function fingerprintSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}

function formatValue(value: unknown): string {
  if (value === undefined) return "-";
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "string" && /[\s"=]/.test(value)) return JSON.stringify(value);
  return String(value);
}

export interface TclkMarketLogger {
  debug(tag: string, fields?: Record<string, unknown>): void;
  info(tag: string, fields?: Record<string, unknown>): void;
}

/** `sink` defaults to console.log; injectable so tests can capture lines instead
 * of printing them. */
export function createLogger(level: LogLevel, sink: (line: string) => void = (l) => console.log(l)): TclkMarketLogger {
  function write(tag: string, fields: Record<string, unknown> = {}): void {
    const ts = new Date().toISOString();
    const parts = [`[TCLK]${tag}`, `ts=${ts}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      parts.push(`${k}=${formatValue(v)}`);
    }
    sink(parts.join(" "));
  }
  return {
    debug(tag, fields) {
      if (level !== "debug") return;
      write(tag, fields);
    },
    info(tag, fields) {
      write(tag, fields);
    },
  };
}
