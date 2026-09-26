/**
 * LIVE ONLY. `live-check`: the single final gate. Every condition live execution needs, verified WITHOUT
 * writing anything: databases opened read-only, key files only read and self-tested in memory, the
 * network used for GETs only (plus Hyperliquid's read-only info query).
 *
 * mode "check": everything must be clean (PASS/FAIL).
 * mode "run":   what `cli-live run` requires to START. Pending writes, UNKNOWN trades and halts do not block
 *               the start (the service must start to reconcile them, read-only, before any new decision),
 *               but they keep new entries blocked inside the service.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { CloseCallConfig } from "../config.js";
import type { Contest } from "../contest.js";
import { backupGate } from "../backup-gate.js";
import { isTradable, keysByRole, listKeys } from "../keys.js";
import { validateKeyDir } from "../keystore.js";
import { openReadonly } from "../monitor.js";
import { liveStrategyKeys } from "../paper.js";
import { activeHalts } from "../safety.js";
import { getMeta } from "../store.js";
import { loadSigners } from "./keygen.js";

export interface ReadinessRow { name: string; ok: boolean; value: string; blocksRun?: boolean }

export interface ReadinessDeps {
  now?: () => number;
  fetch?: typeof fetch;
  /** NTP synchronised? null = cannot tell (not Linux / no timedatectl). */
  ntp?: () => boolean | null;
  /** Skip every network check (offline restore drill). */
  offline?: boolean;
  /** The env file the service reads (for its permissions). */
  envFile?: string | null;
}

const PAPER_DATA_DIR = "/var/lib/flop-closecall";

function ntpSynced(): boolean | null {
  try { return execFileSync("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { encoding: "utf8", timeout: 2000 }).trim() === "yes"; } catch { return null; }
}

async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; value: T | null; error: string | null }> {
  const t0 = performance.now();
  try { const value = await f(); return { ms: Math.round(performance.now() - t0), value, error: null }; } catch (e) { return { ms: Math.round(performance.now() - t0), value: null, error: (e as Error).message }; }
}

/** Largest nonce per DID in our room, as the server holds it (GET only). */
async function serverNonces(base: string, room: string, f: typeof fetch): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  let since = 0;
  for (let page = 0; page < 50; page++) {
    const res = await f(`${base}/r/${room}?format=json&since=${since}&limit=200`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`read ${room}: ${res.status}`);
    const v = JSON.parse((await res.text()).replace(/"nonce":\s*(\d+)/g, '"nonce":"$1"')) as { messages: { seq: number; from: string; nonce?: string }[] };
    for (const m of v.messages) if (m.nonce) { const n = BigInt(m.nonce); if (n > (out.get(m.from) ?? 0n)) out.set(m.from, n); }
    if (v.messages.length < 200) break;
    since = v.messages[v.messages.length - 1].seq;
  }
  return out;
}

export async function liveReadiness(cfg: CloseCallConfig, contest: Contest, writerConnected: boolean, mode: "check" | "run" = "check", deps: ReadinessDeps = {}): Promise<{ pass: boolean; rows: ReadinessRow[] }> {
  const rows: ReadinessRow[] = [];
  const add = (name: string, ok: boolean, value: string, blocksRun = true) => rows.push({ name, ok, value, blocksRun });
  const nowMs = (deps.now ?? Date.now)();
  const f = deps.fetch ?? fetch;

  // ---- configuration and isolation from PAPER
  add("mode", cfg.mode === "live", cfg.mode === "live" ? "LIVE candidate" : `${cfg.mode.toUpperCase()} (CLOSECALL_MODE=live + ack required)`);
  add("writer", writerConnected, writerConnected ? "READY" : "NOT CONNECTED (LIVE_WRITER_CONNECTED = false)");
  const isolated = cfg.dataDir !== PAPER_DATA_DIR && dirname(cfg.dbPath) === cfg.dataDir && dirname(cfg.lockPath) === cfg.dataDir && cfg.keysDir.startsWith(cfg.dataDir) && cfg.dbPath === cfg.liveDbPath;
  add("isolation from paper", isolated, isolated ? `data ${cfg.dataDir} (DB, lock, keys, logs, backups all inside)` : `live must own a separate data dir (not ${PAPER_DATA_DIR}); DB/lock/keys inside it; CLOSECALL_DB_PATH = CLOSECALL_LIVE_DB_PATH`);
  add("room configured", !!cfg.room, cfg.room ?? "CLOSECALL_ROOM not set");
  add("confirmation policy", ["STRICT", "PROTOCOL", "PROBE"].includes(cfg.confirmationPolicy), cfg.confirmationPolicy);
  add("contest", nowMs < contest.firstSweepMs + (contest.lockSweep - 1) * contest.sweepMs, "before the lock");

  // ---- permissions
  const perm = (p: string) => { try { return statSync(p).mode & 0o777; } catch { return null; } };
  const kd = validateKeyDir(cfg.keysDir, cfg.backupDir);
  add("key dir perms", kd.exists && kd.dirOk && kd.files.every((x) => x.ok && x.ownerOk), kd.exists ? `dir ${kd.dirMode}, ${kd.files.length} files${kd.problems.length ? `: ${kd.problems.join("; ")}` : " all 600"}` : "missing");
  const dbMode = perm(cfg.liveDbPath);
  const dataMode = perm(cfg.dataDir);
  add("data perms", dataMode !== null && (dataMode & 0o077) === 0 && dbMode !== null && (dbMode & 0o077) === 0, `data dir ${dataMode?.toString(8) ?? "missing"}, live DB ${dbMode?.toString(8) ?? "missing"} (must be 700 / 600)`);
  if (deps.envFile) { const em = perm(deps.envFile); add("env file perms", em !== null && (em & 0o007) === 0, `${deps.envFile} ${em?.toString(8) ?? "missing"} (no world access)`); }

  // ---- local state (read-only)
  const { db, error } = openReadonly(cfg.liveDbPath);
  if (!db) {
    add("live DB", false, error ?? "unavailable");
    return finish(rows, mode);
  }
  let admin: ReturnType<typeof keysByRole>[number] | undefined;
  let ourDids = new Set<string>();
  try {
    const real = listKeys(db).filter((k) => k.fake === 0);
    admin = keysByRole(db, "admin")[0];
    const staging = keysByRole(db, "staging");
    const strategy = keysByRole(db, "strategy");
    ourDids = new Set(real.map((k) => k.did));
    add("paper keys absent", listKeys(db).every((k) => k.fake === 0), `${listKeys(db).filter((k) => k.fake).length} fake keys in the live DB`);
    add("admin key", !!admin && (isTradable(admin.status) || admin.status === "MINT_CONFIRMED"), admin ? `${admin.id} ${admin.status}` : "missing (CC-ADMIN)");
    add("staging keys", staging.length === 2 && staging.every((k) => isTradable(k.status)), staging.map((k) => `${k.id}:${k.status}`).join(" ") || "none");
    add("staging trade", !!getMeta(db, "test_trade_settled"), getMeta(db, "test_trade_settled") ? `settled at sweep ${getMeta(db, "test_trade_settled")}` : "not settled yet");
    const readyStrategy = strategy.filter((k) => isTradable(k.status));
    add("strategy keys", readyStrategy.length >= 2 && readyStrategy.length === strategy.length, `${readyStrategy.length} READY of ${strategy.length} (${liveStrategyKeys(db).length / 2} pairs)`);
    let signerDetail = "";
    let signersOk = false;
    try { const s = loadSigners(db); signersOk = s.size === real.length && real.length > 0; signerDetail = `${s.size} loaded and self-tested`; } catch (e) { signerDetail = (e as Error).message; }
    add("key files", signersOk, signerDetail || "none");
    const gate = backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient });
    add("encrypted backup", !!cfg.backupAgeRecipient && !!gate.verified, gate.verified ? `${gate.verified.archive} (recipient ${cfg.backupAgeRecipient?.slice(0, 12)}…)` : "none verified");
    add("restore verification", gate.ok, gate.ok ? `verified ${gate.verified!.verified_at.slice(0, 16)}, ${gate.verified!.files.length} key files` : gate.problems.join("; "));
    const plaintext = kd.backup.plaintextFound;
    add("no plaintext key backup", plaintext.length === 0, plaintext.length ? plaintext.join(" ") : "none");
    const dbBackup = getMeta(db, "last_db_backup_at");
    add("state backup (DB)", !!dbBackup && nowMs - Date.parse(dbBackup) < 3 * 3_600_000, dbBackup ? `last ${Math.round((nowMs - Date.parse(dbBackup)) / 60_000)} min ago` : "never", false);
    const room = cfg.room ? (db.prepare("SELECT status FROM rooms_state WHERE name = ?").get(cfg.room) as { status: string } | undefined)?.status ?? "UNCREATED" : null;
    add("room state", room === "READY", cfg.room ? `${cfg.room} ${room}` : "-");
    add("bootstrap", !!getMeta(db, "bootstrap_done_at"), getMeta(db, "bootstrap_done_at") ?? "not done");
    const future = (db.prepare("SELECT COUNT(*) n FROM nonces WHERE CAST(last_nonce AS INTEGER) > ?").get(nowMs + 86_400_000) as { n: number }).n;
    add("nonce store", future === 0, future ? `${future} nonces more than a day ahead of the clock` : `${(db.prepare("SELECT COUNT(*) n FROM nonces").get() as { n: number }).n} scopes persisted`);
    const halts = Object.values(activeHalts(db));
    add("not halted", halts.length === 0, halts.length ? halts.map((h) => `${h.kind}: ${h.reason}`).join(" | ") : "no halt", false);
    const pending = (db.prepare("SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')").get() as { n: number }).n;
    add("pending writes", pending === 0, String(pending), false);
    const unknown = (db.prepare("SELECT COUNT(*) n FROM live_trades WHERE state = 'UNKNOWN'").get() as { n: number }).n;
    add("unknown trades", unknown === 0, String(unknown), false);

    // ---- network (GET only)
    if (deps.offline) {
      add("network checks", true, "skipped (offline drill)", false);
    } else {
      const ntp = (deps.ntp ?? ntpSynced)();
      const cfgRes = await timed(async () => { const r = await f(`${cfg.technocoreBaseUrl}/config`, { signal: AbortSignal.timeout(10_000) }); await r.text(); return r.headers.get("date"); });
      const skew = cfgRes.value ? Math.round(nowMs + cfgRes.ms / 2 - Date.parse(cfgRes.value)) : null;
      add("clock (NTP)", ntp !== false && (skew === null || Math.abs(skew) < 2_000), `NTP ${ntp === null ? "unknown" : ntp ? "synchronized" : "NOT synchronized"}; skew vs technocore ${skew === null ? "n/a" : `${skew} ms`} (±1000 ms resolution)`);
      const ref = await timed(async () => {
        const r = await f(`${cfg.technocoreBaseUrl}/r/d-close1-price?format=json&limit=1`, { signal: AbortSignal.timeout(10_000) });
        const v = JSON.parse(await r.text()) as { messages: { ts: string }[] };
        return v.messages.at(-1)?.ts ?? null;
      });
      add("referee", !!ref.value && nowMs - Date.parse(ref.value) < 600_000, ref.error ? `read failed: ${ref.error}` : `last post ${ref.value ? Math.round((nowMs - Date.parse(ref.value)) / 1000) : "?"} s ago; read ${ref.ms} ms`);
      const hl = await timed(async () => {
        const r = await f(cfg.hyperliquidInfoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "recentTrades", coin: cfg.hyperliquidCoin }), signal: AbortSignal.timeout(10_000) });
        const t = JSON.parse(await r.text()) as { time: number }[];
        return t.length ? Math.max(...t.map((x) => x.time)) : null;
      });
      add("Hyperliquid feed", hl.error === null, hl.error ? `feed DOWN: ${hl.error}` : `feed OK (${hl.ms} ms); last trade ${hl.value ? Math.round((nowMs - hl.value) / 1000) : "?"} s ago (a quiet market is not a broken feed)`);
      const worst = Math.max(cfgRes.ms, ref.ms, hl.ms);
      add("latency", worst < 2_000 && !cfgRes.error, `technocore ${cfgRes.ms} ms, referee read ${ref.ms} ms, Hyperliquid ${hl.ms} ms (posting guard ${cfg.postGuardMs} ms, decision lead ${cfg.decisionLeadMs} ms)`);
      if (cfg.room && admin) {
        const own = await timed(async () => {
          const o = await (await f(`${cfg.technocoreBaseUrl}/kv/room-owners/${cfg.room}`, { signal: AbortSignal.timeout(10_000) })).text();
          const a = await (await f(`${cfg.technocoreBaseUrl}/kv/room-allow/${cfg.room}`, { signal: AbortSignal.timeout(10_000) })).text();
          const strip = (t: string) => { const i = t.indexOf("\n\n"); return (i >= 0 ? t.slice(i + 2) : t).split("\n")[0].trim(); };
          return { owner: strip(o), allow: strip(a).split(/\s+/).filter(Boolean) };
        });
        const okOwner = own.value?.owner === admin.did;
        const foreign = own.value ? own.value.allow.filter((d) => !ourDids.has(d)) : [];
        add("room on server", okOwner && foreign.length === 0, own.error ? `read failed: ${own.error}` : `owner ${okOwner ? "CC-ADMIN" : `NOT ours (${own.value?.owner || "missing"})`}, allow-list ${own.value?.allow.length} DIDs${foreign.length ? `, ${foreign.length} foreign` : ""}`);
        const sn = await timed(() => serverNonces(cfg.technocoreBaseUrl, cfg.room!, f));
        if (sn.value) {
          const local = new Map((db.prepare("SELECT signer_id, last_nonce FROM nonces WHERE scope = ?").all(`room:${cfg.room}`) as { signer_id: string; last_nonce: string }[]).map((r) => [r.signer_id, BigInt(r.last_nonce)]));
          const ahead: string[] = [];
          for (const k of real) { const s = sn.value.get(k.did); if (s !== undefined && s > (local.get(k.id) ?? 0n)) ahead.push(k.id); }
          add("nonce reconciliation", ahead.length === 0, ahead.length ? `server holds newer messages than our journal for ${ahead.join(" ")} (restored from an old backup?): resolve before any write` : `${sn.value.size} keys checked against ${cfg.room}`);
        } else add("nonce reconciliation", false, `read failed: ${sn.error}`);
      }
    }
  } finally {
    db.close();
  }
  return finish(rows, mode);
}

function finish(rows: ReadinessRow[], mode: "check" | "run"): { pass: boolean; rows: ReadinessRow[] } {
  return { pass: rows.every((r) => r.ok || (mode === "run" && r.blocksRun === false)), rows };
}

export function renderReadiness(r: { pass: boolean; rows: ReadinessRow[] }): string {
  return [...r.rows.map((x) => `${x.name.padEnd(26)}${x.ok ? "" : "FAIL  "}${x.value}`), "", `LIVE READINESS: ${r.pass ? "PASS" : "FAIL"}`].join("\n");
}

