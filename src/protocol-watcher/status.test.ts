import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatcher } from "./run.js";
import { openDatabase } from "./database.js";
import { loadProtocolWatcherConfig } from "./config.js";
import { createProtocolWatcherLogger } from "./logger.js";
import { buildStatusReport } from "./status.js";
import type { ProtocolSource } from "./types.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

const SOURCE: ProtocolSource = { id: "yellowpaper", name: "Yellow Paper", url: "https://flop.finance/intro/yellowpaper/", kind: "html-flop", enabled: true };

test("status: reflects persisted snapshot/version/extraction-count/watched-open-item state without any network access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "protocol-watcher-status-"));
  try {
    let call = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(call++ === 0 ? fixture("yellowpaper-v1.html") : fixture("yellowpaper-v2.html"))) as typeof fetch;

    const config = loadProtocolWatcherConfig({ PROTOCOL_WATCHER_DB_PATH: join(dir, "t.sqlite3"), PROTOCOL_WATCHER_CONTENT_DIR: join(dir, "content") });
    const db = openDatabase(config.dbPath);
    const logger = createProtocolWatcherLogger(() => {});
    await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });
    await runWatcher({ config, db, sources: [SOURCE], logger, dryRun: true });

    globalThis.fetch = (() => {
      throw new Error("status must never touch the network");
    }) as typeof fetch;

    const report = buildStatusReport(db);
    globalThis.fetch = original;

    const source = report.sources.find((s) => s.id === "yellowpaper")!;
    assert.equal(source.declaredVersion, "0.5.1 (draft)");
    assert.equal(source.consecutiveErrors, 0);
    assert.ok((source.extractionCounts.tokenomics ?? 0) > 0);
    assert.ok((source.extractionCounts.open_item ?? 0) > 0);
    assert.ok(source.lastChange !== undefined, "the last real change should be recorded");

    const e38 = report.watchedOpenItems.find((i) => i.id === "E.38")!;
    assert.equal(e38.found, true);
    assert.equal(e38.status, "RATIFIED");

    const e35 = report.watchedOpenItems.find((i) => i.id === "E.35")!;
    assert.equal(e35.found, false, "not present in the fixture, and status must say so rather than guessing");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
