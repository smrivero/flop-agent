import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTelegramNotification, splitMessage, createHttpTelegramTransport, TELEGRAM_MESSAGE_LIMIT } from "./telegram.js";
import type { TelegramTransport } from "./telegram.js";

function mockTransport(outcomes: Array<{ ok: boolean; error?: string }>): { transport: TelegramTransport; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    transport: {
      async send(_token, _chat, text) {
        calls.push(text);
        return outcomes[Math.min(i++, outcomes.length - 1)];
      },
    },
  };
}

const ENABLED_CONFIG = { telegramEnabled: true, telegramBotToken: "123:abc", telegramChatId: "999" };

test("telegram: disabled by config never calls the transport", async () => {
  const { transport, calls } = mockTransport([{ ok: true }]);
  const result = await sendTelegramNotification({ telegramEnabled: false }, "hello", transport, false);
  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("telegram: dry-run never calls the transport even when enabled", async () => {
  const { transport, calls } = mockTransport([{ ok: true }]);
  const result = await sendTelegramNotification(ENABLED_CONFIG, "hello", transport, true);
  assert.equal(result.status, "dry_run");
  assert.equal(calls.length, 0);
});

test("telegram: enabled + not dry-run sends via the transport and reports 'sent'", async () => {
  const { transport, calls } = mockTransport([{ ok: true }]);
  const result = await sendTelegramNotification(ENABLED_CONFIG, "hello", transport, false);
  assert.equal(result.status, "sent");
  assert.deepEqual(calls, ["hello"]);
});

test("telegram: a transport failure is reported as 'failed' with the error message", async () => {
  const { transport } = mockTransport([{ ok: false, error: "429 rate limited" }]);
  const result = await sendTelegramNotification(ENABLED_CONFIG, "hello", transport, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "429 rate limited");
});

test("telegram: enabled without bot token/chat id fails without ever calling the transport", async () => {
  const { transport, calls } = mockTransport([{ ok: true }]);
  const result = await sendTelegramNotification({ telegramEnabled: true }, "hello", transport, false);
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 0);
});

test("splitMessage: a short message is returned as a single chunk, unmodified", () => {
  assert.deepEqual(splitMessage("short message"), ["short message"]);
});

test("splitMessage: a long message splits on line boundaries and adds (n/total) markers", () => {
  const longLine = "x".repeat(100);
  const text = Array.from({ length: 200 }, () => longLine).join("\n");
  const chunks = splitMessage(text, 500);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 500 + 20); // + marker overhead
  assert.match(chunks[0], /\(1\/\d+\)$/);
});

test("telegram: a multi-chunk message sends each chunk in order and stops at the first failure", async () => {
  const longLine = "y".repeat(100);
  const text = Array.from({ length: 100 }, () => longLine).join("\n");
  const { transport, calls } = mockTransport([{ ok: true }, { ok: false, error: "boom" }]);
  const result = await sendTelegramNotification(ENABLED_CONFIG, text, transport, false);
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 2, "stops after the failing chunk instead of sending the rest");
});

test("createHttpTelegramTransport: posts to the Telegram API and never sends unless invoked", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const transport = createHttpTelegramTransport(1000);
    assert.equal(called, false, "constructing the transport must not send anything");
    const result = await transport.send("tok", "chat", "hi");
    assert.equal(result.ok, true);
    assert.equal(called, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("TELEGRAM_MESSAGE_LIMIT leaves headroom under Telegram's real 4096-char cap", () => {
  assert.ok(TELEGRAM_MESSAGE_LIMIT < 4096);
});
