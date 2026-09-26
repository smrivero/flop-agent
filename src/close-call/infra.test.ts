import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Alerts, WebhookSink } from "./alerts.js";
import { health, metrics, type RuntimeState } from "./health.js";
import { startHealthServer } from "./http.js";
import { validateKeyDir } from "./keystore.js";
import { ccLog, pruneLogs, redact, setLogSink, setQuiet } from "./logger.js";
import { safetyChecks } from "./run.js";
import { activeHalts, clearTransient, halt, haltSummary, isHalted, unhalt } from "./safety.js";
import { decideStale } from "./stale-policy.js";
import { backupDb, DbIntegrityError, openCloseCallDb, SCHEMA_VERSION } from "./store.js";
import { contest, testConfig, tmpDb } from "./test-helpers.js";

const rt = (): RuntimeState => ({ startedAt: Date.now() - 5_000, observer: "running", observerLastOkAt: Date.now(), strategy: "running", executor: "paper", lastError: null, reconnects: 0, timeouts: 0 });

test("logger: JSON lines with UTC ts, level and component; secrets redacted in both outputs", () => {
  const { dir } = tmpDb();
  const logs = join(dir, "logs");
  setLogSink(logs, { maxFileBytes: 400 });
  ccLog("PAPER INTENT", { sweep: 7, key: "CC001", seedHex: "ab".repeat(32), maker_sig: "SIGNATURE", nested: { privateKey: "x", ok: 1 } });
  ccLog("ERROR", { stage: "t", api_key: "sk-123" });
  for (let i = 0; i < 10; i++) ccLog("OBSERVE", { i, pad: "x".repeat(100) });
  setLogSink(null);
  const files = readdirSync(logs).sort();
  assert.ok(files.length > 1, `rotated by size: ${files.join(",")}`);
  const all = files.map((f) => readFileSync(join(logs, f), "utf8")).join("");
  assert.ok(!/ab{0}abababab|SIGNATURE|sk-123/.test(all.replace(/"\[redacted\]"/g, "")), "no secret value on disk");
  const lines = all.trim().split("\n").map((l) => JSON.parse(l));
  const first = lines.find((l) => l.category === "PAPER INTENT");
  assert.match(first.ts, /Z$/);
  assert.equal(first.level, "info");
  assert.equal(first.component, "execution");
  assert.equal(first.seedHex, "[redacted]");
  assert.deepEqual(first.nested, { privateKey: "[redacted]", ok: 1 });
  assert.equal(lines.find((l) => l.category === "ERROR").level, "error");
  assert.deepEqual(redact({ signature: "s", sweep: 1 }), { signature: "[redacted]", sweep: 1 });
});

test("log retention: old files deleted, total size capped", () => {
  const { dir } = tmpDb();
  mkdirSync(join(dir, "l"));
  const old = join(dir, "l", "events-2026-09-01.jsonl");
  writeFileSync(old, "x");
  utimesSync(old, new Date("2026-09-01"), new Date("2026-09-01"));
  writeFileSync(join(dir, "l", "events-2026-09-25.jsonl"), "y");
  writeFileSync(join(dir, "l", "keep.txt"), "not a log");
  setLogSink(join(dir, "l"), { retentionDays: 14 });
  setLogSink(null);
  assert.deepEqual(readdirSync(join(dir, "l")).sort(), ["events-2026-09-25.jsonl", "keep.txt"]);
  assert.deepEqual(pruneLogs(join(dir, "l")).deleted, []);
});

test("sqlite: WAL, busy_timeout, versioned migrations, integrity check, consistent online backup", async () => {
  const { db, dir } = tmpDb();
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  for (const t of ["sweeps", "raw_posts", "keys", "rooms_state", "intents", "trades", "write_attempts", "nonces", "positions",
    "strategy_triggers", "health_events", "alerts", "void_ids"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
  }
  db.prepare("INSERT INTO health_events (kind, at) VALUES ('x', ?)").run(new Date().toISOString());
  const r = await backupDb(db, join(dir, "b", "copy.sqlite3"));
  assert.ok(r.pages > 0);
  const copy = new Database(join(dir, "b", "copy.sqlite3"), { readonly: true });
  assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((copy.prepare("SELECT COUNT(*) n FROM health_events").get() as { n: number }).n, 1);
  copy.close();
  const reopened = openCloseCallDb(join(dir, "cc.sqlite3"), { checkIntegrity: true });
  assert.equal(reopened.pragma("user_version", { simple: true }), SCHEMA_VERSION, "re-running migrations is a no-op");
  writeFileSync(join(dir, "broken.sqlite3"), "SQLite format 3\u0000" + "garbage".repeat(500));
  assert.throws(() => openCloseCallDb(join(dir, "broken.sqlite3"), { checkIntegrity: true }), (e: Error) => e instanceof DbIntegrityError || /not a database|malformed/i.test(e.message));
});

test("safety: transient halts clear themselves, grave halts need the operator's code; observer is unaffected", () => {
  const { db } = tmpDb();
  assert.equal(isHalted(db), false);
  halt(db, "referee_stale", "silent 3700 s");
  const g = halt(db, "reconcile_mismatch", "L2 books mismatch");
  assert.match(haltSummary(db)!, /HALTED: referee_stale.*\| HALTED: reconcile_mismatch.*unhalt --code/);
  assert.equal(clearTransient(db, "reconcile_mismatch"), false, "a grave halt cannot be auto-cleared");
  assert.equal(clearTransient(db, "referee_stale"), true);
  assert.equal(unhalt(db, "nope"), null);
  assert.equal(unhalt(db, g.code)?.kind, "reconcile_mismatch");
  assert.deepEqual(activeHalts(db), {});
});

test("safety checks: referee silence, stale Hyperliquid and low disk halt and then clear", () => {
  const { db, dir } = tmpDb();
  const cfg = testConfig({ CLOSECALL_DATA_DIR: dir, CLOSECALL_HALT_REFEREE_SILENCE_S: "600", CLOSECALL_HALT_HL_STALE_MS: "60000" });
  const alerts = new Alerts(db, [], 0);
  db.prepare("INSERT INTO raw_posts (room, seq, generation, text, fetched_at) VALUES ('d-close1-price', 1, 1, '{}', ?)").run(new Date(Date.now() - 3_600_000).toISOString());
  safetyChecks(db, cfg, rt(), alerts, { lastOkAt: null }, { feedAgeMs: () => 120_000 });
  assert.deepEqual(Object.keys(activeHalts(db)).sort(), ["hyperliquid_stale", "referee_stale"]);
  db.prepare("INSERT INTO raw_posts (room, seq, generation, text, fetched_at) VALUES ('d-close1-price', 2, 1, '{}', ?)").run(new Date().toISOString());
  safetyChecks(db, cfg, rt(), alerts, { lastOkAt: null }, { feedAgeMs: () => 2_000 });
  assert.deepEqual(activeHalts(db), {});
  const low = testConfig({ CLOSECALL_DATA_DIR: dir, CLOSECALL_DISK_LOW_MB: "999999" });
  safetyChecks(db, low, rt(), alerts, { lastOkAt: null }, { feedAgeMs: () => 2_000 });
  assert.ok(activeHalts(db).disk_low);
  assert.ok((db.prepare("SELECT COUNT(*) n FROM alerts WHERE event = 'disk_low'").get() as { n: number }).n >= 1);
});

test("alerts: logged + stored, repeats suppressed, webhook refuses technocore, sinks optional", async () => {
  const { db } = tmpDb();
  setQuiet(true);
  const sent: unknown[] = [];
  const sink = { name: "t", send: async (a: unknown) => { sent.push(a); } };
  const a = new Alerts(db, [sink], 900);
  assert.equal(await a.raise({ event: "trade_void", severity: "warning", message: "x", key: "t1", detail: { seedHex: "secret" } }, 1_000), true);
  assert.equal(await a.raise({ event: "trade_void", severity: "warning", message: "x", key: "t1" }, 2_000), false, "repeat suppressed");
  assert.equal(await a.raise({ event: "reconcile_mismatch", severity: "critical", message: "y" }, 2_000), true);
  assert.equal(sent.length, 2);
  const row = db.prepare("SELECT detail, delivered FROM alerts WHERE event = 'trade_void'").get() as { detail: string; delivered: string };
  assert.deepEqual(JSON.parse(row.detail), { seedHex: "[redacted]" });
  assert.equal(row.delivered, "log,t");
  assert.throws(() => new WebhookSink("https://technocore.chat/r/x"), /must not point at technocore/);
  assert.equal(Alerts.fromConfig(db, testConfig()).constructor, Alerts, "no credentials needed");
});

test("keys directory: permissions, ownership, encrypted backup status (no key generated or read)", () => {
  const { dir } = tmpDb();
  const keys = join(dir, "keys");
  const backups = join(dir, "backups");
  assert.match(validateKeyDir(keys, backups).problems[0], /does not exist yet/);
  mkdirSync(keys, { mode: 0o755 });
  writeFileSync(join(keys, "CC001.json"), "{}", { mode: 0o644 });
  let r = validateKeyDir(keys, backups);
  assert.ok(r.problems.some((p) => /must be 700/.test(p)));
  assert.ok(r.problems.some((p) => /must be 600/.test(p)));
  assert.ok(r.problems.some((p) => /no encrypted key backup/.test(p)));
  chmodSync(keys, 0o700);
  chmodSync(join(keys, "CC001.json"), 0o600);
  mkdirSync(backups);
  writeFileSync(join(backups, "keys-2026.tar.gz"), "plain");
  writeFileSync(join(backups, "keys-2026.tar.gz.age"), "enc");
  r = validateKeyDir(keys, backups);
  assert.deepEqual(r.problems, ["keys-2026.tar.gz: plaintext key archive in the backup directory -- delete it"]);
  assert.equal(r.backup.encrypted, true);
});

test("stale policy decisions", () => {
  const cfg = testConfig().stalePolicy;
  const d = (i: Partial<Parameters<typeof decideStale>[1]>) => decideStale(cfg, { ageS: 2, delayMin: 0.5, divergenceBps: 3, refEstimated: false, ...i }).decision;
  assert.equal(d({}), "TRADE");
  assert.equal(d({ refEstimated: true }), "REDUCE");
  assert.equal(d({ ageS: 90 }), "REDUCE");
  assert.equal(d({ ageS: 90, divergenceBps: 80 }), "HALT_NEW_ENTRIES");
  assert.equal(d({ ageS: 300 }), "HALT_NEW_ENTRIES");
  assert.equal(d({ delayMin: 50 }), "HALT_NEW_ENTRIES");
  assert.equal(decideStale({ ...cfg, mode: "REDUCE" }, { ageS: 9999, delayMin: 0, divergenceBps: 0, refEstimated: false }).decision, "REDUCE");
});

test("health: every field, Prometheus metrics, local read-only server with no secrets", async () => {
  const { db, dir } = tmpDb();
  const cfg = testConfig({ CLOSECALL_DATA_DIR: dir });
  const h = health(db, cfg, contest(), rt());
  for (const k of ["status", "mode", "process", "sweep", "hyperliquid", "db", "disk", "observer", "strategy", "executor", "execution_halted",
    "reconciliation", "keys", "pending_writes", "last_error", "counters"]) assert.ok(k in h, k);
  assert.equal(h.db.ok, true);
  assert.match(metrics(h), /closecall_execution_halted 0/);
  const srv = await startHealthServer("127.0.0.1", 0, () => h, () => ({ ok: true }));
  const addr = srv.address() as { address: string; port: number };
  assert.equal(addr.address, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  const body = await (await fetch(`${base}/health`)).text();
  assert.ok(!/seed|privateKey|sig"/.test(body));
  assert.equal((await fetch(`${base}/metrics`)).status, 200);
  assert.equal((await fetch(`${base}/health`, { method: "POST" })).status, 405);
  srv.close();
});

test("bootstrap plan: limits read from the server (not hardcoded), 103 writes without / 104 with the test trade", async () => {
  const { bootstrapPlan, fetchLimits } = await import("./limits.js");
  const fake = (async (url: string) => new Response(JSON.stringify(url.endsWith("/config")
    ? { version: "9.9", settings: { rate_write: 120, rate_read: 600, rate_rooms_per_day: 20, dupe_filter_seconds: 120, dupe_max_copies: 5 } }
    : { limits: { message_chars: 4096, note_chars: 8192, retention_seconds: 604800 } }))) as unknown as typeof fetch;
  const limits = await fetchLimits("http://x", fake);
  assert.equal(limits.writesPerMinPerIp, 120, "whatever the server says");
  const p = bootstrapPlan(limits, 100, 0);
  assert.equal(p.writes.withoutTestTrade, 103);
  assert.equal(p.writes.withTestTrade, 104);
  assert.equal(p.writes.claim + p.writes.allowList + p.writes.ownerCC001 + p.writes.roomRegistration + p.writes.otherOwners, 103);
  assert.equal(p.timing.pureWriteSeconds, 52, "104 writes at 120/min");
  assert.equal(bootstrapPlan({ ...limits, writesPerMinPerIp: 300 }, 100, 0).timing.pureWriteSeconds, 21);
});

test("Close Call runtime manifest: its own deps (Node 24 needs better-sqlite3 >= 13), scripts pinned, never the shared package.json", () => {
  const rt = JSON.parse(readFileSync(join(process.cwd(), "deploy/closecall/package.json"), "utf8")) as { dependencies: Record<string, string>; allowScripts: Record<string, boolean>; engines: { node: string } };
  assert.match(rt.dependencies["better-sqlite3"], /^1[3-9]\.\d+\.\d+$/, "pinned, 13+ (11.x/12.x abort in Statement::~Statement on Node >= 24.19)");
  assert.match(rt.dependencies.tsx, /^\d+\.\d+\.\d+$/, "pinned");
  assert.equal(rt.allowScripts[`better-sqlite3@${rt.dependencies["better-sqlite3"]}`], false, "prebuilt N-API binary ships in the package: no node-gyp");
  assert.ok(Object.keys(rt.allowScripts).every((k) => k === "fsevents" || /@\d+\.\d+\.\d+$/.test(k)), "every allowed entry is version-pinned");
  assert.match(rt.engines.node, />=24\.19/);
  const lock = JSON.parse(readFileSync(join(process.cwd(), "deploy/closecall/package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
  assert.equal(lock.packages["node_modules/better-sqlite3"].version, rt.dependencies["better-sqlite3"]);
  const inst = readFileSync(join(process.cwd(), "scripts/install-closecall-service.sh"), "utf8");
  assert.match(inst, /v24\.21\.0/);
  assert.match(inst, /ln -sfn "\$RT" "\$APP\/node_modules"/);
});
