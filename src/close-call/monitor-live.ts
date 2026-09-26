/**
 * The live half of the monitor. READ ONLY and no business rule of its own: every value comes from what the
 * service and the gate already compute -- the readiness gate (readiness.ts, the same function live-check runs,
 * here in local mode: no network), the live journal, keys, the backup gate, and the meta the service writes
 * (room_health, room generation, last_readiness with the network rows of the last service start, hl feed).
 */

import type Database from "better-sqlite3";
import type { CloseCallConfig } from "./config.js";
import type { Contest } from "./contest.js";
import { backupGate, filesDigest, keyFileHashes } from "./backup-gate.js";
import { validateKeyDir } from "./keystore.js";
import { liveReadiness, type ReadinessRow } from "./readiness.js";

type Db = Database.Database;
type N<T> = T | null;

export const JOURNAL_STATES = ["CREATED", "SIGNED", "POSTING", "POSTED", "CONFIRMED", "LATE", "SETTLED", "VOID", "NOT_APPLIED", "NOT_POSTED", "FAILED", "UNKNOWN"] as const;
export const KEY_FLAGS = ["GENERATED", "BACKED_UP", "REGISTERED", "MINT_PENDING", "MINT_CONFIRMED", "ROOM_ALLOWED", "READY", "ACTIVE", "ERROR"] as const;

export interface LiveMonitor {
  classes: { admin: string[]; staging: string[]; strategy: { count: number; first: N<string>; last: N<string> }; strategyPairs: number };
  flags: Record<string, number>;
  byRole: Record<string, Record<string, number>>;
  backup: { ok: boolean; latest: N<string>; latestAt: N<string>; restoreOk: boolean; keysNewer: boolean; plaintext: boolean; detail: string };
  room: { name: N<string>; exists: N<boolean>; owner: N<string>; allowCount: N<number>; expectedWriters: number; status: string; lastRefresh: N<string>;
    generation: N<string>; missing: boolean; checkedAt: N<string>; why: N<string> };
  nonces: { scopes: number; status: string; mismatch: N<string>; lastReconcile: N<string> };
  journal: { counts: Record<string, number>; pending: number; unknown: number; lastId: N<string>; lastState: N<string>; lastPost: N<string>; lastReferee: N<string>; lastTransition: N<string> };
  readiness: { pass: boolean; local: ReadinessRow[]; network: ReadinessRow[]; networkAt: N<string>; networkPass: N<boolean> };
  clock: { system: string; ntp: N<boolean>; skew: N<string> };
  lastTechnocoreWrite: N<string>;
  lastBackupVerify: N<string>;
}

const q = <T>(db: Db, sql: string, ...a: unknown[]): T | undefined => { try { return db.prepare(sql).get(...a) as T | undefined; } catch { return undefined; } };
const qa = <T>(db: Db, sql: string, ...a: unknown[]): T[] => { try { return db.prepare(sql).all(...a) as T[]; } catch { return []; } };
const meta = (db: Db, k: string) => q<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", k)?.value ?? null;

export async function collectLive(db: Db, cfg: CloseCallConfig, contest: Contest, now: number, ntp?: () => boolean | null): Promise<LiveMonitor> {
  const keys = qa<{ id: string; did: string; role: string | null; status: string; registered: number; minted: number }>(db, "SELECT id, did, role, status, registered, minted FROM keys WHERE fake = 0 ORDER BY id");
  const role = (r: string) => keys.filter((k) => k.role === r);
  const strategy = role("strategy");
  const allowSeen = new Set<string>((() => { try { return JSON.parse(meta(db, "room_allow_seen") ?? "[]") as string[]; } catch { return []; } })());
  const gate = (() => { try { return backupGate(db, { keysDir: cfg.keysDir, backupDir: cfg.backupDir, recipient: cfg.backupAgeRecipient }); } catch { return null; } })();
  const backed = new Set((gate?.verified?.files ?? []).map((f) => f.name.replace(/\.json$/, "")));
  const flags: Record<string, number> = Object.fromEntries(KEY_FLAGS.map((f) => [f, 0]));
  for (const k of keys) {
    if (k.status === "GENERATED") flags.GENERATED++;
    if (backed.has(k.id)) flags.BACKED_UP++;
    if (k.registered) flags.REGISTERED++;
    if (k.status === "REGISTER_PENDING" || k.status === "MINT_EXPECTED" || k.status === "PROBE_PENDING") flags.MINT_PENDING++;
    if (k.minted) flags.MINT_CONFIRMED++;
    if (allowSeen.has(k.did)) flags.ROOM_ALLOWED++;
    if (k.status === "READY") flags.READY++;
    if (k.status === "ACTIVE") flags.ACTIVE++;
    if (k.status === "ERROR") flags.ERROR++;
  }
  const byRole: Record<string, Record<string, number>> = {};
  for (const k of keys) { const r = k.role ?? "none"; byRole[r] = byRole[r] ?? {}; byRole[r][k.status] = (byRole[r][k.status] ?? 0) + 1; }

  // backup
  const kd = validateKeyDir(cfg.keysDir, cfg.backupDir);
  const current = keyFileHashes(cfg.keysDir);
  const keysNewer = !!gate?.verified && filesDigest(current) !== gate.verified.files_digest;
  const backup = {
    ok: !!cfg.backupAgeRecipient && !!gate?.verified, latest: gate?.verified?.archive ?? null,
    latestAt: gate?.verified?.archive.match(/secrets-(\d{8}T\d{6}Z)/)?.[1] ?? null, restoreOk: !!gate?.ok, keysNewer,
    plaintext: kd.backup.plaintextFound.length > 0, detail: gate ? (gate.ok ? "verified" : gate.problems[0] ?? "") : "no live DB",
  };

  // room (what the RoomKeeper / bootstrap recorded; the monitor does not call technocore)
  const rh = (() => { try { return JSON.parse(meta(db, "room_health") ?? "null") as { ok: boolean; why?: string; at: string; last_seq?: number } | null; } catch { return null; } })();
  const serverAllow = (() => { try {
    const lr = JSON.parse(meta(db, "last_readiness") ?? "null") as { rows: ReadinessRow[] } | null;
    const m = lr?.rows.find((x) => x.name === "room on server")?.value.match(/allow-list (\d+) DIDs/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; } })();
  const rs = cfg.room ? q<{ status: string; owner_did: string | null }>(db, "SELECT status, owner_did FROM rooms_state WHERE name = ?", cfg.room) : undefined;
  const admin = role("admin")[0];
  const room = {
    name: cfg.room, exists: rh ? (rh.ok ? (rh.last_seq ?? 1) > 0 : false) : null,
    owner: rs?.owner_did ? (admin && rs.owner_did === admin.did ? `${admin.id}` : `${rs.owner_did.slice(0, 16)}…`) : null,
    allowCount: Math.max(allowSeen.size, serverAllow) || null, expectedWriters: role("staging").length + strategy.length, status: rs?.status ?? (cfg.room ? "UNCREATED" : "not set"),
    lastRefresh: meta(db, "room_refresh_at"), generation: cfg.room ? meta(db, `room_generation:${cfg.room}`) : null,
    missing: rh ? !rh.ok : false, checkedAt: rh?.at ?? null, why: rh && !rh.ok ? rh.why ?? null : null,
  };

  // readiness: the SAME gate, local mode (no network), + the network rows the service recorded at start
  const r = await liveReadiness(cfg, contest, "check", { offline: true, now: () => now, ntp });
  const last = (() => { try { return JSON.parse(meta(db, "last_readiness") ?? "null") as { at: string; pass: boolean; rows: ReadinessRow[] } | null; } catch { return null; } })();
  const localNames = new Set(r.rows.map((x) => x.name));
  const network = (last?.rows ?? []).filter((x) => !localNames.has(x.name));
  const row = (name: string) => [...r.rows, ...network].find((x) => x.name === name);

  const counts = Object.fromEntries(JOURNAL_STATES.map((s) => [s, 0])) as Record<string, number>;
  for (const x of qa<{ state: string; n: number }>(db, "SELECT state, COUNT(*) n FROM live_trades GROUP BY state")) counts[x.state] = x.n;
  const lastT = q<{ trade_id: string; state: string; updated_at: string }>(db, "SELECT trade_id, state, updated_at FROM live_trades ORDER BY updated_at DESC LIMIT 1");
  return {
    classes: { admin: role("admin").map((k) => k.id), staging: role("staging").map((k) => k.id),
      strategy: { count: strategy.length, first: strategy[0]?.id ?? null, last: strategy.at(-1)?.id ?? null }, strategyPairs: Math.floor(strategy.length / 2) },
    flags, byRole, backup, room,
    nonces: { scopes: q<{ n: number }>(db, "SELECT COUNT(*) n FROM nonces")?.n ?? 0, status: row("nonce store")?.ok === false ? `FAIL ${row("nonce store")!.value}` : "OK",
      mismatch: row("nonce reconciliation") ? (row("nonce reconciliation")!.ok ? "0" : row("nonce reconciliation")!.value) : null, lastReconcile: last?.at ?? null },
    journal: { counts, pending: counts.CREATED + counts.SIGNED + counts.POSTING + counts.POSTED + counts.CONFIRMED, unknown: counts.UNKNOWN,
      lastId: lastT?.trade_id.slice(0, 12) ?? null, lastState: lastT?.state ?? null,
      lastPost: q<{ t: string | null }>(db, "SELECT MAX(post_at) t FROM live_trades")?.t ?? null,
      lastReferee: q<{ t: string | null }>(db, "SELECT MAX(referee_at) t FROM live_trades")?.t ?? null, lastTransition: lastT?.updated_at ?? null },
    readiness: { pass: r.pass && (last ? last.pass : false), local: r.rows, network, networkAt: last?.at ?? null, networkPass: last ? last.pass : null },
    clock: { system: new Date(now).toISOString(), ntp: (() => { const v = row("NTP")?.value ?? ""; return /NOT synchronized/.test(v) ? false : /synchronized/.test(v) ? true : null; })(), skew: row("clock skew")?.value ?? null },
    lastTechnocoreWrite: q<{ t: string | null }>(db, "SELECT MAX(updated_at) t FROM write_attempts WHERE state = 'CONFIRMED'")?.t ?? null,
    lastBackupVerify: gate?.verified?.verified_at ?? null,
  };
}
