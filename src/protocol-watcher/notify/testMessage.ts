/**
 * `protocol:test-notify` -- a connectivity check, not a real alert. Sends a
 * fixed, clearly-labeled message over whichever channels are enabled, so an
 * operator can confirm Telegram/Technocore delivery works right after
 * configuring it, without waiting for (or faking) a real protocol change.
 *
 * Deliberately bypasses the normal notify gating that depends on a real
 * ProtocolChange (isPublishWorthy, "no more than one summary per batch",
 * etc.) -- there is no change here to gate on -- and never touches
 * protocol_changes/protocol_events/protocol_notifications: this is not a
 * real batch, so it must never be mistaken for one in `protocol:status` or
 * `protocol:diff`.
 */

import type { TelegramTransport } from "./telegram.js";
import type { TechnocoreSender } from "./technocore.js";

export function buildTestMessage(now: Date = new Date()): string {
  return [
    "FLOP Protocol Watcher -- connectivity test",
    "",
    "This is NOT a real protocol change. It confirms this delivery channel is configured",
    "correctly. Real alerts only fire when an official FLOP source actually changes.",
    "",
    `Sent: ${now.toISOString()}`,
  ].join("\n");
}

export interface TestNotifyConfig {
  telegramEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  technocoreEnabled: boolean;
  technocoreRoom: string;
}

export interface TestNotifyChannelResult {
  channel: "telegram" | "technocore";
  attempted: boolean;
  ok: boolean;
  error?: string;
}

export async function sendTestNotifications(
  config: TestNotifyConfig,
  transports: { telegramTransport?: TelegramTransport; technocoreSender?: TechnocoreSender },
  now: Date = new Date(),
): Promise<TestNotifyChannelResult[]> {
  const text = buildTestMessage(now);
  const results: TestNotifyChannelResult[] = [];

  if (config.telegramEnabled) {
    if (!config.telegramBotToken || !config.telegramChatId || !transports.telegramTransport) {
      results.push({ channel: "telegram", attempted: false, ok: false, error: "enabled but bot token/chat id/transport missing" });
    } else {
      const result = await transports.telegramTransport.send(config.telegramBotToken, config.telegramChatId, text);
      results.push({ channel: "telegram", attempted: true, ok: result.ok, error: result.error });
    }
  } else {
    results.push({ channel: "telegram", attempted: false, ok: false, error: "disabled (PROTOCOL_WATCHER_TELEGRAM_ENABLED=false)" });
  }

  if (config.technocoreEnabled) {
    if (!transports.technocoreSender) {
      results.push({ channel: "technocore", attempted: false, ok: false, error: "enabled but sender missing" });
    } else {
      try {
        await transports.technocoreSender.sendSignedMessage(config.technocoreRoom, text);
        results.push({ channel: "technocore", attempted: true, ok: true });
      } catch (err) {
        results.push({ channel: "technocore", attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } else {
    results.push({ channel: "technocore", attempted: false, ok: false, error: "disabled (PROTOCOL_WATCHER_TECHNOCORE_ENABLED=false)" });
  }

  return results;
}
