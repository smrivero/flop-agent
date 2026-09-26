/**
 * LIVE ONLY. Disaster-recovery drill on a RESTORED live data dir (any path: nothing here reads the original
 * machine's paths). Read only on the restored copy; no network.
 *
 * It reports each part separately -- never one global PASS for things it cannot know offline:
 *   RESTORE INTEGRITY  sqlite integrity_check + schema
 *   KEY SELF-TEST      every key reloads from <restored>/keys/<id>.json, DID = the DB's, sign -> verify
 *   KEY PATH REMAP     stored key_path values that name another data dir are ignored (keys load by id)
 *   DB RESTORE         tables readable (keys, journal, nonces, strategy, room)
 *   STRATEGY STATE     present or fresh
 *   JOURNAL            live_trades / write journal: anything in flight is listed (a live start resolves it by read-back)
 *   NONCES             persisted, none in the future
 *   BACKUP METADATA    the archive being restored is checked against ITS OWN manifest (canary + key-file digest). The DB
 *                      snapshot inside it can only carry the PREVIOUS verification (an archive is verified after it
 *                      exists), so that is EXPECTED, not a failure.
 *   NETWORK GATES      SKIPPED OFFLINE (room on server, nonce reconciliation, referee, clock: live-check on the machine)
 *   ROOM / ROLES       what the state says (e.g. not bootstrapped yet), for information
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { verifyEd25519 } from "../../identity.js";
import { canarySha, filesDigest, keyFileHashes, type BackupManifest } from "../backup-gate.js";
import type { CloseCallConfig } from "../config.js";
import { listKeys } from "../keys.js";
import { openReadonly } from "../monitor.js";
import { SCHEMA_VERSION } from "../store.js";
import { loadSigners } from "./keygen.js";

export interface DrillSection { name: string; status: "PASS" | "FAIL" | "EXPECTED" | "RECONSTRUCTED" | "SKIPPED" | "INFO"; detail: string }

export function restoreDrill(cfg: CloseCallConfig, archivePath: string | null, nowMs = Date.now()): { pass: boolean; sections: DrillSection[] } {
  const out: DrillSection[] = [];
  const add = (name: string, status: DrillSection["status"], detail: string) => out.push({ name, status, detail });
  const { db, error } = openReadonly(cfg.liveDbPath);
  if (!db) {
    add("RESTORE INTEGRITY", "FAIL", error ?? "no live DB in the restored dir");
    return { pass: false, sections: out };
  }
  try {
    const ic = db.pragma("integrity_check", { simple: true }) as string;
    const ver = db.pragma("user_version", { simple: true }) as number;
    add("RESTORE INTEGRITY", ic === "ok" && ver <= SCHEMA_VERSION ? "PASS" : "FAIL", `integrity ${ic}, schema v${ver} (code v${SCHEMA_VERSION}${ver < SCHEMA_VERSION ? ", migrates on first open" : ""})`);

    const real = listKeys(db).filter((k) => k.fake === 0);
    try {
      const signers = loadSigners(db, cfg.keysDir);
      const bad = real.filter((k) => { const s = signers.get(k.id); const m = `drill|${k.id}`; return !s || s.did !== k.did || !verifyEd25519(k.did, s.sign(m), m); });
      add("KEY SELF-TEST", real.length > 0 && !bad.length ? "PASS" : "FAIL", `${signers.size}/${real.length} keys reload from ${cfg.keysDir}, DID matches, sign -> verify${bad.length ? `; FAILED ${bad.map((k) => k.id).join(" ")}` : ""}`);
    } catch (e) {
      add("KEY SELF-TEST", "FAIL", (e as Error).message);
    }
    const foreignPaths = real.filter((k) => k.key_path && !k.key_path.startsWith(cfg.keysDir)).length;
    add("KEY PATH REMAP", "PASS", `${foreignPaths} stored key_path value(s) name another data dir; ignored -- keys load by id from ${cfg.keysDir}`);

    const count = (t: string) => { try { return (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n; } catch { return -1; } };
    const tables = ["keys", "live_trades", "write_attempts", "nonces", "strategy_state", "rooms_state", "meta"];
    const missing = tables.filter((t) => count(t) < 0);
    add("DB RESTORE", missing.length ? "FAIL" : "PASS", missing.length ? `unreadable: ${missing.join(" ")}` : tables.map((t) => `${t} ${count(t)}`).join(", "));

    const st = db.prepare("SELECT json FROM strategy_state WHERE name = 'K'").get() as { json: string } | undefined;
    add("STRATEGY STATE", "PASS", st ? `restored: ${st.json.slice(0, 90)}` : "none yet (Strategy K not started: it starts fresh at the live price)");

    const inflight = (db.prepare("SELECT COUNT(*) n FROM write_attempts WHERE state NOT IN ('CONFIRMED','FAILED')").get() as { n: number }).n;
    const unknown = (db.prepare("SELECT COUNT(*) n FROM live_trades WHERE state = 'UNKNOWN'").get() as { n: number }).n;
    add("JOURNAL", "PASS", `${count("live_trades")} live trades, ${count("write_attempts")} journaled writes; in flight at backup time: ${inflight} writes, ${unknown} UNKNOWN (a live start resolves them by read-back only)`);

    const future = (db.prepare("SELECT COUNT(*) n FROM nonces WHERE CAST(last_nonce AS INTEGER) > ?").get(nowMs + 86_400_000) as { n: number }).n;
    add("NONCES", future ? "FAIL" : "PASS", `${count("nonces")} scopes persisted${future ? `, ${future} in the future` : ""}; server comparison = live-check on the machine`);

    // Backup metadata: the archive under restore vs ITS OWN manifest (the snapshot can only hold the previous verification).
    const restored = keyFileHashes(cfg.keysDir);
    const snapVerified = (() => { try { return JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'backup_verified'").get() as { value: string } | undefined)?.value ?? "null") as { archive: string } | null; } catch { return null; } })();
    if (archivePath) {
      const manifestPath = join(cfg.backupDir, basename(archivePath).replace(/\.tar\.age$/, ".manifest.json"));
      if (existsSync(manifestPath)) {
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
        const shaOk = !existsSync(archivePath) || createHash("sha256").update(readFileSync(archivePath)).digest("hex") === m.archive_sha256;
        const ok = shaOk && m.files_digest === filesDigest(restored) && m.canary_sha256 === canarySha(cfg.keysDir);
        add("BACKUP METADATA", ok ? "RECONSTRUCTED" : "FAIL", ok
          ? `${m.archive}: ${m.files.length} key files and canary match its manifest; the snapshot inside records ${snapVerified ? `the previous verification (${snapVerified.archive})` : "no earlier verification"} -- EXPECTED (an archive is verified after it exists)`
          : `${m.archive}: restored keys/canary/archive do NOT match its manifest`);
      } else {
        add("BACKUP METADATA", "EXPECTED", `no manifest for ${basename(archivePath)} in ${cfg.backupDir} (pull it with the archive); decryption + key self-test prove the content`);
      }
    } else {
      add("BACKUP METADATA", "EXPECTED", `snapshot records ${snapVerified ? snapVerified.archive : "no verification"}; pass --archive to check the restored archive against its manifest`);
    }

    add("NETWORK GATES", "SKIPPED", "offline: room on server, generation, nonce reconciliation, referee, Hyperliquid, clock -> live-check on the machine");
    const room = cfg.room ? (db.prepare("SELECT status FROM rooms_state WHERE name = ?").get(cfg.room) as { status: string } | undefined)?.status ?? "UNCREATED" : null;
    const gen = cfg.room ? (db.prepare("SELECT value FROM meta WHERE key = ?").get(`room_generation:${cfg.room}`) as { value: string } | undefined)?.value : undefined;
    add("ROOM", "INFO", !cfg.room ? "not configured" : room === "UNCREATED" ? `${cfg.room}: UNCONFIGURED (not yet bootstrapped)` : `${cfg.room}: ${room}, generation ${gen ?? "not pinned yet"}`);
    const roles = ["admin", "staging", "strategy"].map((r) => `${r} ${real.filter((k) => k.role === r).length}`).join(", ");
    add("ROLES", "INFO", `${roles} (keys not created yet are normal before their phase)`);
  } finally {
    db.close();
  }
  const pass = out.every((s) => s.status !== "FAIL");
  return { pass, sections: out };
}

export function renderDrill(r: { pass: boolean; sections: DrillSection[] }): string {
  return [...r.sections.map((s) => `${s.name.padEnd(20)}${s.status.padEnd(14)}${s.detail}`), "",
    `DISASTER RECOVERY (offline part): ${r.pass ? "PASS" : "FAIL"}   (network gates: run live-check on the restored machine)`].join("\n");
}
