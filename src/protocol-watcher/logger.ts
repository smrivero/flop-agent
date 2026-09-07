/**
 * JSON-Lines logging for the protocol watcher, one object per line, per this
 * feature's own logging requirement. Deliberately separate from every other
 * module's logger (mentions/debate use "[tag] k=v" text, tclk-marketplace
 * uses "[TCLK][TAG] k=v") -- this file is the only place that decides this
 * module's log shape, and nothing outside src/protocol-watcher/ imports it.
 *
 * SECURITY: never pass a token, API key, or full page content as a field --
 * call sites decide what's safe (same discipline as mentions/http.ts).
 */

export interface ProtocolWatcherLogFields {
  action: string;
  sourceId?: string;
  previousVersion?: string;
  currentVersion?: string;
  normalizedHash?: string;
  changeCount?: number;
  severity?: string;
  telegramSent?: boolean;
  technocorePublished?: boolean;
  durationMs?: number;
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export type ProtocolWatcherLogSink = (line: string) => void;

export interface ProtocolWatcherLogger {
  log(fields: ProtocolWatcherLogFields): void;
}

/** `sink` defaults to console.log; injectable so tests capture lines instead
 * of printing them, and so cron's `>> logs/protocol-watcher.log 2>&1`
 * redirection keeps working unchanged. */
export function createProtocolWatcherLogger(sink: ProtocolWatcherLogSink = (l) => console.log(l)): ProtocolWatcherLogger {
  return {
    log(fields) {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        component: "protocol-watcher",
        ...fields,
      });
      sink(line);
    },
  };
}
