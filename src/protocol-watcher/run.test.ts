import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatcher } from "./run.js";
import { openDatabase, getLatestSnapshot, getChangesForBatch, getExtractions, getRecentNotifications } from "./database.js";
import { loadProtocolWatcherConfig } from "./config.js";
import { createProtocolWatcherLogger } from "./logger.js";
import type { ProtocolSource } from "./types.js";
import type { TelegramTransport } from "./notify/telegram.js";
import type { TechnocoreSender } from "./notify/technocore.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

function withTempEnv(fn: (paths: { dbPath: string; contentDir: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-run-"));
  return fn({ dbPath: join(dir, "test.sqlite3"), contentDir: join(dir, "content") }).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

const SOURCE: ProtocolSource = { id: "yellowpaper", name: "Yellow Paper", url: "https://flop.finance/intro/yellowpaper/", kind: "html-flop", enabled: true };

function silentLogger() {
  const lines: unknown[] = [];
  return { logger: createProtocolWatcherLogger((l) => lines.push(JSON.parse(l))), lines };
}

function stubFetch(responder: (url: string) => { body: string; status?: number } | "throw"): () => void {
  const original = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string) => {
    const outcome = responder(String(url));
    if (outcome === "throw") throw new Error("simulated network failure");
    const status = outcome.status ?? 200;
    const nullBodyStatus = status === 204 || status === 205 || status === 304;
    return new Response(nullBodyStatus ? null : outcome.body, { status });
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("run: first execution creates a baseline snapshot and raises no changes/alerts", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    const restore = stubFetch(() => ({ body: fixture("yellowpaper-v1.html") }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      const summary = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });

      assert.equal(summary.outcomes[0].status, "baseline_created");
      const latest = getLatestSnapshot(db, "yellowpaper");
      assert.ok(latest);
      assert.equal(latest!.is_baseline, 1);
      assert.equal(getChangesForBatch(db, summary.changeBatchId).length, 0);
      assert.ok(getExtractions(db, latest!.id).length > 0);
      db.close();
    } finally {
      restore();
    }
  }));

test("run: a second execution with unchanged content does not create a duplicate snapshot", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    const restore = stubFetch(() => ({ body: fixture("yellowpaper-v1.html") }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      const secondSummary = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });

      assert.equal(secondSummary.outcomes[0].status, "no_change");
      const count = db.prepare("SELECT COUNT(*) AS c FROM protocol_snapshots").get() as { c: number };
      assert.equal(count.c, 1, "no duplicate snapshot row for byte-different-but-semantically-identical content");
      db.close();
    } finally {
      restore();
    }
  }));

test("run: markup-only cosmetic differences do not create a duplicate snapshot either", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => ({ body: call++ === 0 ? fixture("yellowpaper-v1.html") : fixture("yellowpaper-v1-cosmetic.html") }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      const second = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      assert.equal(second.outcomes[0].status, "no_change");
      db.close();
    } finally {
      restore();
    }
  }));

test("run: a prose-only ('cosmetic') edit outside tracked fields creates a new snapshot but raises no alert", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => ({ body: call++ === 0 ? fixture("yellowpaper-v1.html") : fixture("yellowpaper-v1-typo-fix.html") }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      const second = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });

      assert.equal(second.outcomes[0].status, "cosmetic_only");
      const count = db.prepare("SELECT COUNT(*) AS c FROM protocol_snapshots").get() as { c: number };
      assert.equal(count.c, 2, "the raw/normalized hash did change, so a snapshot IS recorded");
      assert.equal(getChangesForBatch(db, second.changeBatchId).length, 0, "but no structural change means no alert");
      db.close();
    } finally {
      restore();
    }
  }));

test("run: a real change (version + validator stake + E.38 + implementation status) produces a structured diff", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => ({ body: call++ === 0 ? fixture("yellowpaper-v1.html") : fixture("yellowpaper-v2.html") }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      const second = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });

      assert.equal(second.outcomes[0].status, "changed");
      if (second.outcomes[0].status !== "changed") throw new Error("unreachable");
      assert.ok(second.outcomes[0].changes.length > 0);
      assert.ok(second.outcomes[0].changes.some((c) => c.itemId === "E.38" && c.severity === "action_required"));
      assert.ok(second.outcomes[0].changes.some((c) => c.field === "validator_min_stake"));
      db.close();
    } finally {
      restore();
    }
  }));

test("run: a 304 Not Modified never creates a snapshot", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => (call++ === 0 ? { body: fixture("yellowpaper-v1.html") } : { body: "", status: 304 }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      const second = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      assert.equal(second.outcomes[0].status, "not_modified");
      const count = db.prepare("SELECT COUNT(*) AS c FROM protocol_snapshots").get() as { c: number };
      assert.equal(count.c, 1);
      db.close();
    } finally {
      restore();
    }
  }));

test("run: one source failing (network error) does not prevent other sources from being processed", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    const restore = stubFetch((url) => (url.includes("broken") ? "throw" : { body: fixture("yellowpaper-v1.html") }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      const sources: ProtocolSource[] = [
        { id: "broken", name: "Broken", url: "https://example.test/broken", kind: "html-flop", enabled: true },
        SOURCE,
      ];
      const summary = await runWatcher({ config, db, sources, logger, dryRun: true });
      assert.equal(summary.outcomes[0].status, "error");
      assert.equal(summary.outcomes[1].status, "baseline_created");
      db.close();
    } finally {
      restore();
    }
  }));

test("run: an empty response body is treated as a failure and never overwrites the last valid snapshot", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => (call++ === 0 ? { body: fixture("yellowpaper-v1.html") } : { body: "   " }));
    try {
      const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: dbPath, PROTOCOL_WATCHER_CONTENT_DIR: contentDir });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      const before = getLatestSnapshot(db, "yellowpaper")!;

      const second = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      assert.equal(second.outcomes[0].status, "error");

      const after = getLatestSnapshot(db, "yellowpaper")!;
      assert.equal(after.id, before.id);
      assert.equal(after.normalized_hash, before.normalized_hash);
      db.close();
    } finally {
      restore();
    }
  }));

test("run: dry-run with Telegram+Technocore enabled previews notifications without ever calling the real senders", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => ({ body: call++ === 0 ? fixture("yellowpaper-v1.html") : fixture("yellowpaper-v2.html") }));
    let telegramCalls = 0;
    let technocoreCalls = 0;
    const telegramTransport: TelegramTransport = { async send() { telegramCalls++; return { ok: true }; } };
    const technocoreSender: TechnocoreSender = { async sendSignedMessage() { technocoreCalls++; return {}; } };
    try {
      const config = loadProtocolWatcherConfig({
        PROTOCOL_WATCHER_DB_PATH: dbPath,
        PROTOCOL_WATCHER_CONTENT_DIR: contentDir,
        PROTOCOL_WATCHER_TELEGRAM_ENABLED: "true",
        PROTOCOL_WATCHER_TELEGRAM_BOT_TOKEN: "123:abc",
        PROTOCOL_WATCHER_TELEGRAM_CHAT_ID: "999",
        PROTOCOL_WATCHER_TECHNOCORE_ENABLED: "true",
      });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true, telegramTransport, technocoreSender });
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true, telegramTransport, technocoreSender });

      assert.equal(telegramCalls, 0, "dry-run must never call the real Telegram transport");
      assert.equal(technocoreCalls, 0, "dry-run must never call the real Technocore sender");

      const notifications = getRecentNotifications(db, 10);
      assert.ok(notifications.some((n) => n.channel === "telegram" && n.status === "dry_run"));
      assert.ok(notifications.some((n) => n.channel === "technocore" && n.status === "dry_run"));
      db.close();
    } finally {
      restore();
    }
  }));

test("run: with dryRun=false and both channels enabled, a real change is sent via the injected mock senders", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    let call = 0;
    const restore = stubFetch(() => ({ body: call++ === 0 ? fixture("yellowpaper-v1.html") : fixture("yellowpaper-v2.html") }));
    let telegramCalls = 0;
    let technocoreCalls = 0;
    const telegramTransport: TelegramTransport = { async send() { telegramCalls++; return { ok: true }; } };
    const technocoreSender: TechnocoreSender = { async sendSignedMessage() { technocoreCalls++; return {}; } };
    try {
      const config = loadProtocolWatcherConfig({
        PROTOCOL_WATCHER_DB_PATH: dbPath,
        PROTOCOL_WATCHER_CONTENT_DIR: contentDir,
        PROTOCOL_WATCHER_TELEGRAM_ENABLED: "true",
        PROTOCOL_WATCHER_TELEGRAM_BOT_TOKEN: "123:abc",
        PROTOCOL_WATCHER_TELEGRAM_CHAT_ID: "999",
        PROTOCOL_WATCHER_TECHNOCORE_ENABLED: "true",
      });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: false, telegramTransport, technocoreSender });
      await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: false, telegramTransport, technocoreSender });

      assert.equal(telegramCalls, 1);
      assert.equal(technocoreCalls, 1);
      const notifications = getRecentNotifications(db, 10);
      assert.ok(notifications.some((n) => n.channel === "telegram" && n.status === "sent"));
      assert.ok(notifications.some((n) => n.channel === "technocore" && n.status === "sent"));
      db.close();
    } finally {
      restore();
    }
  }));

test("run: retention prunes old, unreferenced snapshots but never the latest one", () =>
  withTempEnv(async ({ dbPath, contentDir }) => {
    const restore = stubFetch(() => ({ body: fixture("yellowpaper-v1.html") }));
    try {
      const config = loadProtocolWatcherConfig({
        PROTOCOL_WATCHER_DB_PATH: dbPath,
        PROTOCOL_WATCHER_CONTENT_DIR: contentDir,
        PROTOCOL_WATCHER_RETENTION_DAYS: "0",
      });
      const db = openDatabase(dbPath);
      const { logger } = silentLogger();
      const summary = await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
      assert.equal(summary.retention.snapshotsPruned, 0, "the only (and latest) snapshot must survive retention");
      db.close();
    } finally {
      restore();
    }
  }));
