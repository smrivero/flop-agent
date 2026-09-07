import { test } from "node:test";
import assert from "node:assert/strict";
import { publishTechnocoreSummary, isPublishWorthy, createRealTechnocoreSender, TECHNOCORE_SUMMARY_CHAR_LIMIT } from "./technocore.js";
import { IdentityError } from "../../identity.js";
import type { TechnocoreSender } from "./technocore.js";
import type { ProtocolChange } from "../types.js";

const CONFIG = { technocoreEnabled: true, technocoreRoom: "d-flop-protocol-watch" };

function change(overrides: Partial<ProtocolChange>): ProtocolChange {
  return {
    sourceId: "yellowpaper",
    detectedAt: "2026-09-10T00:00:00.000Z",
    category: "other",
    changeType: "modified",
    severity: "info",
    evidence: { url: "https://flop.finance/intro/yellowpaper/" },
    ...overrides,
  };
}

function mockSender(behavior: "ok" | "throw"): { sender: TechnocoreSender; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sender: {
      async sendSignedMessage(room, text) {
        calls.push(`${room}:${text}`);
        if (behavior === "throw") throw new Error("technocore write failed");
        return { seq: 1 };
      },
    },
  };
}

test("isPublishWorthy: false for metadata-only, non-action_required changes (cosmetic)", () => {
  assert.equal(isPublishWorthy([change({ category: "other", severity: "info" }), change({ category: "other", severity: "important" })]), false);
});

test("isPublishWorthy: true for any protocol-category change (validator/agent/etc.)", () => {
  assert.equal(isPublishWorthy([change({ category: "validator", severity: "info" })]), true);
});

test("isPublishWorthy: true for an action_required change even if categorized 'other'", () => {
  assert.equal(isPublishWorthy([change({ category: "other", severity: "action_required" })]), true);
});

test("technocore: disabled by config never calls the sender", async () => {
  const { sender, calls } = mockSender("ok");
  const result = await publishTechnocoreSummary({ ...CONFIG, technocoreEnabled: false }, [change({ category: "validator" })], "summary", sender, false);
  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("technocore: skips cosmetic-only changes without calling the sender", async () => {
  const { sender, calls } = mockSender("ok");
  const result = await publishTechnocoreSummary(CONFIG, [change({ category: "other", severity: "info" })], "summary", sender, false);
  assert.equal(result.status, "skipped");
  assert.equal(calls.length, 0);
});

test("technocore: dry-run never calls the sender even for a real change", async () => {
  const { sender, calls } = mockSender("ok");
  const result = await publishTechnocoreSummary(CONFIG, [change({ category: "validator" })], "summary", sender, true);
  assert.equal(result.status, "dry_run");
  assert.equal(calls.length, 0);
});

test("technocore: enabled + real change + not dry-run publishes exactly once via the mock sender", async () => {
  const { sender, calls } = mockSender("ok");
  const result = await publishTechnocoreSummary(CONFIG, [change({ category: "validator" })], "summary text", sender, false);
  assert.equal(result.status, "sent");
  assert.deepEqual(calls, ["d-flop-protocol-watch:summary text"]);
});

test("technocore: a sender failure is reported as 'failed', never thrown", async () => {
  const { sender } = mockSender("throw");
  const result = await publishTechnocoreSummary(CONFIG, [change({ category: "validator" })], "summary text", sender, false);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /technocore write failed/);
});

test("technocore: truncates an overlong summary defensively before publishing", async () => {
  const { sender, calls } = mockSender("ok");
  const longText = "x".repeat(TECHNOCORE_SUMMARY_CHAR_LIMIT + 500);
  await publishTechnocoreSummary(CONFIG, [change({ category: "validator" })], longText, sender, false);
  const [sentText] = calls[0].split(":").slice(1);
  assert.ok(calls[0].length < longText.length);
});

test("createRealTechnocoreSender: never generates an identity -- throws IdentityError when none exists on disk", () => {
  assert.throws(() => createRealTechnocoreSender({ identityPath: "/nonexistent/identity.json" }), IdentityError);
});
