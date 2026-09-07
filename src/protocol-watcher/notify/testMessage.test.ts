import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestMessage, sendTestNotifications } from "./testMessage.js";
import type { TelegramTransport } from "./telegram.js";
import type { TechnocoreSender } from "./technocore.js";

test("buildTestMessage: clearly labels itself as a connectivity test, not a real change", () => {
  const message = buildTestMessage(new Date("2026-09-10T00:00:00.000Z"));
  assert.match(message, /connectivity test/i);
  assert.match(message, /NOT a real protocol change/);
  assert.match(message, /2026-09-10T00:00:00\.000Z/);
});

test("sendTestNotifications: both channels disabled -> neither is attempted", async () => {
  const results = await sendTestNotifications({ telegramEnabled: false, technocoreEnabled: false, technocoreRoom: "r" }, {});
  assert.deepEqual(
    results.map((r) => r.attempted),
    [false, false],
  );
});

test("sendTestNotifications: telegram enabled sends via the transport and reports ok", async () => {
  const calls: string[] = [];
  const telegramTransport: TelegramTransport = {
    async send(token, chat, text) {
      calls.push(`${token}:${chat}`);
      assert.match(text, /connectivity test/i);
      return { ok: true };
    },
  };
  const results = await sendTestNotifications(
    { telegramEnabled: true, telegramBotToken: "tok", telegramChatId: "chat", technocoreEnabled: false, technocoreRoom: "r" },
    { telegramTransport },
  );
  const telegram = results.find((r) => r.channel === "telegram")!;
  assert.equal(telegram.attempted, true);
  assert.equal(telegram.ok, true);
  assert.deepEqual(calls, ["tok:chat"]);
});

test("sendTestNotifications: technocore enabled publishes via the sender and reports ok", async () => {
  const calls: string[] = [];
  const technocoreSender: TechnocoreSender = {
    async sendSignedMessage(room, text) {
      calls.push(room);
      assert.match(text, /connectivity test/i);
      return {};
    },
  };
  const results = await sendTestNotifications(
    { telegramEnabled: false, technocoreEnabled: true, technocoreRoom: "d-flop-protocol-watch" },
    { technocoreSender },
  );
  const technocore = results.find((r) => r.channel === "technocore")!;
  assert.equal(technocore.attempted, true);
  assert.equal(technocore.ok, true);
  assert.deepEqual(calls, ["d-flop-protocol-watch"]);
});

test("sendTestNotifications: a sender failure is reported, never thrown", async () => {
  const technocoreSender: TechnocoreSender = {
    async sendSignedMessage() {
      throw new Error("room not claimed");
    },
  };
  const results = await sendTestNotifications(
    { telegramEnabled: false, technocoreEnabled: true, technocoreRoom: "d-flop-protocol-watch" },
    { technocoreSender },
  );
  const technocore = results.find((r) => r.channel === "technocore")!;
  assert.equal(technocore.ok, false);
  assert.match(technocore.error!, /room not claimed/);
});

test("sendTestNotifications: enabled without bot token/chat id is reported, not attempted", async () => {
  const results = await sendTestNotifications({ telegramEnabled: true, technocoreEnabled: false, technocoreRoom: "r" }, {});
  const telegram = results.find((r) => r.channel === "telegram")!;
  assert.equal(telegram.attempted, false);
  assert.match(telegram.error!, /missing/);
});
