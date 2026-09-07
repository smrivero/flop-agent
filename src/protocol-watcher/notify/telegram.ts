/**
 * New integration -- no Telegram code exists anywhere else in this project
 * to reuse. Disabled by default (PROTOCOL_WATCHER_TELEGRAM_ENABLED=false);
 * the real HTTP transport is never constructed, let alone called, unless a
 * caller explicitly asks for it, and `sendTelegramNotification` never
 * touches the network at all in dry-run.
 *
 * Sending is a single attempt, no retry -- same rationale as this project's
 * own Technocore publisher (mentions/publisher/publishMention.ts): Telegram's
 * sendMessage isn't idempotent, so retrying a timed-out request risks a
 * double-post. A real failure is just reported as failed.
 */

import { fetchWithTimeout } from "../../mentions/http.js";

export const TELEGRAM_MESSAGE_LIMIT = 4000; // Telegram's own cap is 4096; leaves headroom for chunk markers.

/** Splits on line boundaries so a chunk never cuts a line in half; appends a
 * "(n/total)" marker only when more than one chunk is actually needed. */
export function splitMessage(text: string, maxLen: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, i) => `${chunk}\n\n(${i + 1}/${chunks.length})`);
}

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

export interface TelegramTransport {
  send(botToken: string, chatId: string, text: string): Promise<TelegramSendResult>;
}

/** The real transport -- constructing this does not send anything; it's only
 * ever invoked from sendTelegramNotification, and only when enabled and not
 * a dry run. */
export function createHttpTelegramTransport(timeoutMs: number): TelegramTransport {
  return {
    async send(botToken, chatId, text) {
      try {
        const response = await fetchWithTimeout(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) },
          timeoutMs,
        );
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return { ok: false, error: `HTTP ${response.status}${body ? ` -- ${body.slice(0, 200)}` : ""}` };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface TelegramNotifyConfig {
  telegramEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export type NotificationOutcomeStatus = "sent" | "failed" | "skipped" | "dry_run";

export interface NotifyResult {
  status: NotificationOutcomeStatus;
  error?: string;
}

export async function sendTelegramNotification(config: TelegramNotifyConfig, text: string, transport: TelegramTransport, dryRun: boolean): Promise<NotifyResult> {
  if (!config.telegramEnabled) return { status: "skipped" };
  if (dryRun) return { status: "dry_run" };
  if (!config.telegramBotToken || !config.telegramChatId) return { status: "failed", error: "telegram enabled but bot token/chat id missing" };

  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const result = await transport.send(config.telegramBotToken, config.telegramChatId, chunk);
    if (!result.ok) return { status: "failed", error: result.error };
  }
  return { status: "sent" };
}
