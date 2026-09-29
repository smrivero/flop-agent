/**
 * Live readiness: THE single implementation of the live gate. `live-check` and `cli-live run` call it (with
 * the key-file self-test injected from live/), and the monitor calls it in local mode (no network, no key
 * material) -- so the monitor can never show a different verdict from the gate. `live-check`: the single final gate. Every condition live execution needs, verified WITHOUT
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
import type { CloseCallConfig } from "./config.js";
import type { Contest } from "./contest.js";
import { backupGate } from "./backup-gate.js";
import { isTradable, keysByRole, listKeys } from "./keys.js";
import { validateKeyDir } from "./keystore.js";
import { openReadonly } from "./monitor.js";
import { liveStrategyKeys } from "./paper.js";
import { activeHalts, writerState } from "./safety.js";
import { getMeta } from "./store.js";
import { fresh } from "./journal.js";
import { REFEREE_DID } from "./protocol.js";
import { REFEREE_PACKAGE_SHA256, verifyVendor } from "./fold.js";

export interface ReadinessRow { name: string; ok: boolean; value: string; blocksRun?: boolean; bootOptional?: boolean }

/** `bootstrap` = what must hold BEFORE the first write (it does not require what the bootstrap itself creates). */
export type ReadinessMode = "check" | "run" | "bootstrap";

/** Rows that describe what the bootstrap CREATES: not required before it. */
const BOOT_OPTIONAL = new Set(["writer", "staging trade", "strategy keys", "room state", "bootstrap", "referee seed", "state backup (DB)"]);

export interface RoomServerState {
  state: "VIRGIN" | "OURS" | "FOREIGN" | "DELETED" | "UNCLAIMABLE";
  foreign: number; detail: string; generationOk: boolean; generationDetail: string;
}

/**
 * What the server says about our room, with local evidence:
 *   VIRGIN       no owner/allow/nonce note, no message, generation 0, and we never configured it (nothing to lose)
 *   OURS         owner note = CC-ADMIN (allow-list checked for foreign DIDs)
 *   FOREIGN      someone else owns it
 *   DELETED      we had configured it (recorded generation / local room state) and the server lost it
 *   UNCLAIMABLE  messages but no owner note: can never be claimed
 */
export function classifyRoom(x: { owner: string | null; allow: string | null; nonce: string | null; lastSeq: number; generation: number;
  adminDid: string; ourDids: Set<string>; storedGeneration: number | null; everConfigured: boolean }): RoomServerState {
  const allow = (x.allow ?? "").split(/\s+/).filter(Boolean);
  const foreign = allow.filter((d) => !x.ourDids.has(d)).length;
  const empty = x.owner === null && x.allow === null && x.nonce === null && x.lastSeq === 0 && x.generation === 0;
  const gen = (ok: boolean, d: string) => ({ generationOk: ok, generationDetail: d });
  if (empty && !x.everConfigured) {
    return { state: "VIRGIN", foreign: 0, detail: "VIRGIN (not created): owner ABSENT, allow ABSENT, nonce ABSENT, messages 0, generation 0", ...gen(true, "0 / NOT CREATED (the bootstrap pins it)") };
  }
  if (x.everConfigured && (x.owner === null || (x.storedGeneration !== null && (x.lastSeq === 0 || x.generation === 0)))) {
    return { state: "DELETED", foreign, detail: `DELETED / GENERATION LOST: we configured it (recorded generation ${x.storedGeneration ?? "none"}), server now: owner ${x.owner === null ? "ABSENT" : "present"}, messages ${x.lastSeq}, generation ${x.generation}`,
      ...gen(false, `GENERATION LOST: recorded ${x.storedGeneration ?? "none"}, server ${x.generation} (${x.lastSeq} messages)`) };
  }
  if (x.owner === null) {
    return { state: x.lastSeq > 0 ? "UNCLAIMABLE" : "VIRGIN", foreign, detail: x.lastSeq > 0 ? `UNCLAIMABLE: ${x.lastSeq} messages and no owner note` : "owner ABSENT (notes only?)", ...gen(x.lastSeq === 0, `server ${x.generation}`) };
  }
  if (x.owner !== x.adminDid) return { state: "FOREIGN", foreign, detail: `FOREIGN owner ${x.owner.slice(0, 24)}…`, ...gen(false, `server ${x.generation}`) };
  const g = x.storedGeneration === null
    ? gen(true, x.lastSeq === 0 ? "notes only, no message yet (pinned at the first messages)" : `server ${x.generation}, recorded none yet`)
    : gen(x.generation === x.storedGeneration && x.lastSeq > 0, x.generation === x.storedGeneration ? `server ${x.generation} = recorded` : `CHANGED: recorded ${x.storedGeneration}, server ${x.generation}`);
  return { state: "OURS", foreign, detail: `OURS: owner CC-ADMIN, allow-list ${x.allow === null ? "ABSENT" : `${allow.length} DIDs`}${foreign ? `, ${foreign} FOREIGN` : ""}, nonce ${x.nonce ?? "ABSENT"}, messages ${x.lastSeq}`, ...g };
}

export interface ReadinessDeps {
  now?: () => number;
  fetch?: typeof fetch;
  /** NTP synchronised? null = cannot tell (not Linux / no timedatectl). */
  ntp?: () => boolean | null;
  /** Skip every network check (offline restore drill). */
  offline?: boolean;
  /** The env file the service reads (for its permissions). */
  envFile?: string | null;
  /** Key files reload + self-test (sign/verify). Injected by live/ only; absent in the monitor. */
  signerCheck?: (db: import("./store.js").CcDb) => { ok: boolean; detail: string };
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

export async function liveReadiness(cfg: CloseCallConfig, contest: Contest, mode: ReadinessMode = "check", deps: ReadinessDeps = {}): Promise<{ pass: boolean; rows: ReadinessRow[] }> {
  const rows: ReadinessRow[] = [];
  const add = (name: string, ok: boolean, value: string, blocksRun = true) => rows.push({ name, ok, value, blocksRun });
  const nowMs = (deps.now ?? Date.now)();
  const f = deps.fetch ?? fetch;

  // ---- configuration and isolation from PAPER
  add("mode", cfg.mode === "live", cfg.mode === "live" ? "LIVE candidate" : `${cfg.mode.toUpperCase()} (CLOSECALL_MODE=live + ack required)`);
  const w = writerState(cfg);
  // The writer is connected in this build; it is only ever DISARMED by configuration or the kill switch.
  // `run` may start disarmed (observer + reconciliation only, no decisions); `check` needs it armed.
  add("writer", w.armed, w.armed ? "ARMED (connected; CLOSECALL_LIVE_WRITER=armed, no kill switch)" : `DISARMED: ${w.reason}`, false);
  const isolated = cfg.dataDir !== PAPER_DATA_DIR && dirname(cfg.dbPath) === cfg.dataDir && dirname(cfg.lockPath) === cfg.dataDir && cfg.keysDir.startsWith(cfg.dataDir) && cfg.dbPath === cfg.liveDbPath;
  add("isolation from paper", isolated, isolated ? `data ${cfg.dataDir} (DB, lock, keys, logs, backups all inside)` : `live must own a separate data dir (not ${PAPER_DATA_DIR}); DB/lock/keys inside it; CLOSECALL_DB_PATH = CLOSECALL_LIVE_DB_PATH`);
  add("room configured", !!cfg.room, cfg.room ?? "CLOSECALL_ROOM not set");
  add("confirmation policy", ["STRICT", "PROTOCOL", "PROBE"].includes(cfg.confirmationPolicy), cfg.confirmationPolicy);
  add("contest", nowMs < contest.firstSweepMs + (contest.lockSweep - 1) * contest.sweepMs, "before the lock");
  // The official package, byte for byte: manifest pinned by the referee's seed, every file incl. contest.json
  // (contest id + timeline) and the fold matching it. A different package is never accepted silently.
  try {
    const v = verifyVendor(cfg.vendorRoot);
    add("contest package", contest.contestId === "close-1", `manifest ${v.manifestSha256.slice(0, 12)}… (pinned), fold ${v.foldSha256.slice(0, 12)}…, contest ${contest.contestId}, lock sweep ${contest.lockSweep}`);
  } catch (e) {
    add("contest package", false, (e as Error).message);
  }

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
    const seed = db.prepare("SELECT package FROM seed WHERE id = 1").get() as { package: string } | undefined;
    const seedFrom = (db.prepare("SELECT from_did FROM raw_posts WHERE room = 'd-close1-price' AND text LIKE '%\"t\":\"seed\"%' LIMIT 1").get() as { from_did: string } | undefined)?.from_did;
    add("referee seed", !!seed && seed.package === REFEREE_PACKAGE_SHA256 && seedFrom === REFEREE_DID,
      seed ? `package ${seed.package === REFEREE_PACKAGE_SHA256 ? "= pinned" : `CHANGED ${seed.package.slice(0, 12)}…`}, signed by ${seedFrom === REFEREE_DID ? "the referee" : `UNEXPECTED ${seedFrom}`}` : "no seed observed in the live DB yet");
    add("paper keys absent", listKeys(db).every((k) => k.fake === 0), `${listKeys(db).filter((k) => k.fake).length} fake keys in the live DB`);
    add("admin key", !!admin && (mode === "bootstrap" || isTradable(admin.status) || admin.status === "MINT_CONFIRMED"), admin ? `${admin.id} ${admin.status}` : "missing (CC-ADMIN)");
    add("staging keys", staging.length === 2 && (mode === "bootstrap" || staging.every((k) => isTradable(k.status))), staging.map((k) => `${k.id}:${k.status}`).join(" ") || "none");
    add("staging trade", !!getMeta(db, "test_trade_settled"), getMeta(db, "test_trade_settled") ? `settled at sweep ${getMeta(db, "test_trade_settled")}` : "not settled yet");
    const readyStrategy = strategy.filter((k) => isTradable(k.status));
    add("strategy keys", readyStrategy.length >= 2 && readyStrategy.length === strategy.length, `${readyStrategy.length} READY of ${strategy.length} (${liveStrategyKeys(db).length / 2} pairs)`);
    if (deps.signerCheck) {
      const sc = deps.signerCheck(db);
      add("key files", sc.ok && real.length > 0, sc.detail);
    }
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
    const ntpLocal = (deps.ntp ?? ntpSynced)();
    add("NTP", ntpLocal !== false, `NTP ${ntpLocal === null ? "unknown (no timedatectl)" : ntpLocal ? "synchronized" : "NOT synchronized"}; system time ${new Date(nowMs).toISOString()}`);
    if (deps.offline) {
      add("network checks", true, "skipped (local mode: see live-check / service start)", false);
    } else {
      const ntp = ntpLocal;
      const cfgRes = await timed(async () => { const r = await f(`${cfg.technocoreBaseUrl}/config`, { signal: AbortSignal.timeout(10_000) }); await r.text(); return r.headers.get("date"); });
      const skew = cfgRes.value ? Math.round(nowMs + cfgRes.ms / 2 - Date.parse(cfgRes.value)) : null;
      add("clock skew", ntp !== false && (skew === null || Math.abs(skew) < 2_000), `skew vs technocore ${skew === null ? "n/a" : `${skew} ms`} (±1000 ms resolution)`);
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
      // Latency budget from READS only (5 samples): p50 / p95.
      const sample = async (fn: () => Promise<unknown>) => { const ms: number[] = []; for (let i = 0; i < 5; i++) ms.push((await timed(fn as () => Promise<unknown>)).ms); ms.sort((a, b) => a - b); return { p50: ms[2], p95: ms[4] }; };
      const tc = await sample(async () => (await f(`${cfg.technocoreBaseUrl}/config`, { signal: AbortSignal.timeout(10_000) })).text());
      const hs = await sample(async () => (await f(cfg.hyperliquidInfoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "recentTrades", coin: cfg.hyperliquidCoin }), signal: AbortSignal.timeout(10_000) })).text());
      add("latency", tc.p95 < 2_000 && hs.p95 < 2_000 && !cfgRes.error, `technocore p50 ${tc.p50} / p95 ${tc.p95} ms, referee read ${ref.ms} ms, Hyperliquid p50 ${hs.p50} / p95 ${hs.p95} ms`);
      // Posting path per sweep: ~3 reads (writers, generation) + up to maxTradesPerSweep serialized POSTs, each ~ one round trip,
      // twice for safety, must fit in (decision lead - posting guard).
      const need = 2 * (3 + cfg.maxTradesPerSweep) * tc.p95;
      const have = cfg.decisionLeadMs - cfg.postGuardMs;
      add("deadline margin", need < have && cfg.postGuardMs >= 2 * tc.p95, `budget ${have} ms (lead ${cfg.decisionLeadMs} - guard ${cfg.postGuardMs}) vs ${need} ms needed for ${cfg.maxTradesPerSweep} trades at p95; guard ${cfg.postGuardMs} ms vs 2 x p95 = ${2 * tc.p95} ms`);
      if (cfg.room && admin) {
        // Every read is status-aware: a 404 on a note is the semantic state ABSENT, never a value to parse.
        const readNote = async (ns: string) => {
          const res = await f(fresh(`${cfg.technocoreBaseUrl}/kv/${ns}/${cfg.room}`), { signal: AbortSignal.timeout(10_000) });
          if (res.status === 404) { await res.text(); return null; }
          if (!res.ok) throw new Error(`${ns}: HTTP ${res.status}`);
          const t = await res.text();
          const i = t.indexOf("\n\n");
          return (i >= 0 ? t.slice(i + 2) : t).split("\n")[0].trim() || null;
        };
        const srv = await timed(async () => {
          const res = await f(fresh(`${cfg.technocoreBaseUrl}/r/${cfg.room}?format=json&limit=1`), { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`room read: HTTP ${res.status}`);
          const view = JSON.parse(await res.text()) as { last_seq?: number; generation?: number };
          return { owner: await readNote("room-owners"), allow: await readNote("room-allow"), nonce: await readNote("room-nonce"),
            lastSeq: view.last_seq ?? 0, generation: view.generation ?? 0 };
        });
        const stored = getMeta(db, `room_generation:${cfg.room}`);
        const localState = (db.prepare("SELECT status FROM rooms_state WHERE name = ?").get(cfg.room) as { status: string } | undefined)?.status ?? "UNCREATED";
        const everConfigured = stored !== null || localState !== "UNCREATED";
        const rs = srv.value ? classifyRoom({ ...srv.value, adminDid: admin.did, ourDids, storedGeneration: stored === null ? null : Number(stored), everConfigured }) : null;
        add("room on server", !!rs && (rs.state === "OURS" || (rs.state === "VIRGIN" && mode === "bootstrap")) && rs.foreign === 0,
          srv.error ? `read failed: ${srv.error}` : rs!.detail, true);
        rows[rows.length - 1].bootOptional = false;
        add("room generation", !!rs && rs.generationOk && (rs.state !== "VIRGIN" || mode === "bootstrap"),
          srv.error ? `read failed: ${srv.error}` : rs!.generationDetail);
        // Notes share /kv/room-nonce/<room>: the server counter must not be ahead of our last signed note.
        const rn = await timed(async () => { const res = await f(fresh(`${cfg.technocoreBaseUrl}/kv/room-nonce/${cfg.room}`), { signal: AbortSignal.timeout(10_000) }); if (!res.ok) return null; const t = await res.text(); const i = t.indexOf("\n\n"); return (i >= 0 ? t.slice(i + 2) : t).split("\n")[0].trim(); });
        const localNote = (db.prepare("SELECT MAX(CAST(last_nonce AS INTEGER)) m FROM nonces WHERE scope = ?").get(`note:${cfg.room}`) as { m: number | null }).m;
        if (rn.value && /^\d+$/.test(rn.value) && localNote !== null) {
          add("note nonce (room-nonce)", BigInt(rn.value) <= BigInt(localNote), `server ${rn.value}, ours ${localNote}`);
        }
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

function finish(rows: ReadinessRow[], mode: ReadinessMode): { pass: boolean; rows: ReadinessRow[] } {
  for (const r of rows) if (r.bootOptional === undefined) r.bootOptional = BOOT_OPTIONAL.has(r.name);
  return { pass: rows.every((r) => r.ok || (mode === "run" && r.blocksRun === false) || (mode === "bootstrap" && r.bootOptional)), rows };
}

/**
 * What stops `live run` from starting. A DISARMED writer does not: the service then starts in catch-up / observe
 * mode (no intent, no signature, no POST) and the operator arms it later with `live arm`, which re-runs the gate.
 * With the writer disarmed, only GRAVE halts block the start: a transient one (referee_stale left by an outage)
 * clears itself once the service observes again -- it could never clear if it kept the service from starting.
 */
export function runStartBlockers(rows: ReadinessRow[], writerArmed: boolean, onlyTransientHalts: boolean): ReadinessRow[] {
  return rows.filter((r) => !r.ok && r.name !== "writer" && !(r.name === "not halted" && !writerArmed && onlyTransientHalts));
}

export function renderReadiness(r: { pass: boolean; rows: ReadinessRow[] }): string {
  return [...r.rows.map((x) => `${x.name.padEnd(26)}${x.ok ? "" : "FAIL  "}${x.value}`), "", `LIVE READINESS: ${r.pass ? "PASS" : "FAIL"}`].join("\n");
}

