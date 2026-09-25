/**
 * Alerts, decoupled from where they go. Every alert is logged ([CLOSECALL][ALERT])
 * and stored in the `alerts` table; optional sinks (a generic JSON webhook, a
 * Telegram bot) are only active when their settings exist. Repeats of the same
 * event+key are suppressed for `minIntervalS`.
 *
 * Alerts never carry key material or signatures: fields go through the logger's
 * redaction first.
 */

import type { CloseCallConfig } from "./config.js";
import { ccLog, redact } from "./logger.js";
import { now, type CcDb } from "./store.js";

export type AlertEvent =
  | "process_restart" | "reconcile_mismatch" | "referee_stale" | "hyperliquid_stale" | "trade_void" | "trade_state_unknown"
  | "key_error" | "room_ownership" | "db_error" | "disk_low" | "execution_halted" | "execution_resumed";

export type Severity = "info" | "warning" | "critical";

export interface Alert { event: AlertEvent; severity: Severity; message: string; detail?: Record<string, unknown>; key?: string }

export interface AlertSink { name: string; send(a: Alert): Promise<void> }

export class WebhookSink implements AlertSink {
  name = "webhook";
  constructor(private url: string, private fetchImpl: typeof fetch = fetch) {
    if (/technocore\.chat/i.test(url)) throw new Error("alert webhook must not point at technocore.chat");
  }
  async send(a: Alert): Promise<void> {
    await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "flop-closecall", ...a, detail: redact(a.detail ?? {}) }), signal: AbortSignal.timeout(10_000) });
  }
}

export class TelegramSink implements AlertSink {
  name = "telegram";
  constructor(private token: string, private chatId: string, private fetchImpl: typeof fetch = fetch) {}
  async send(a: Alert): Promise<void> {
    await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: `[closecall ${a.severity}] ${a.event}: ${a.message}` }), signal: AbortSignal.timeout(10_000) });
  }
}

export class Alerts {
  private last = new Map<string, number>();
  constructor(private db: CcDb | null, private sinks: AlertSink[] = [], private minIntervalS = 900) {}

  static fromConfig(db: CcDb | null, cfg: CloseCallConfig): Alerts {
    const sinks: AlertSink[] = [];
    if (cfg.alerts.webhookUrl) sinks.push(new WebhookSink(cfg.alerts.webhookUrl));
    if (cfg.alerts.telegramBotToken && cfg.alerts.telegramChatId) sinks.push(new TelegramSink(cfg.alerts.telegramBotToken, cfg.alerts.telegramChatId));
    return new Alerts(db, sinks, cfg.alerts.minIntervalS);
  }

  /** Returns true if the alert was emitted (false if suppressed as a repeat). */
  async raise(a: Alert, nowMs = Date.now()): Promise<boolean> {
    const k = `${a.event}|${a.key ?? ""}`;
    const prev = this.last.get(k);
    if (prev !== undefined && nowMs - prev < this.minIntervalS * 1000 && a.severity !== "critical") return false;
    this.last.set(k, nowMs);
    ccLog("ALERT", { event: a.event, severity: a.severity, key: a.key, ...(a.detail ?? {}) }, a.message);
    const delivered: string[] = ["log"];
    for (const s of this.sinks) {
      try { await s.send(a); delivered.push(s.name); } catch (e) { ccLog("ERROR", { stage: "alert_sink", sink: s.name, error: (e as Error).message }); }
    }
    if (this.db) {
      this.db.prepare("INSERT INTO alerts (event, severity, message, detail, delivered, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(a.event, a.severity, a.message, JSON.stringify(redact(a.detail ?? {})), delivered.join(","), now());
    }
    return true;
  }
}
