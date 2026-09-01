/**
 * Periodic, best-effort local archival of the debate room via the real
 * Technocore export endpoint (GET /r/<room>/export, raw JSONL, byte-exact --
 * see technocore.ts `exportRoom`; confirmed against the live docs, not
 * invented). Saved alongside a SHA-256 of the exact bytes written, so the
 * local copy is independently checkable without re-fetching it.
 *
 * Deliberately decoupled from the debate turn loop: this is called from
 * loop.ts as a side check once per iteration, wrapped so a failure here can
 * never affect message generation/publishing. It has its own schedule
 * (ARCHIVE_INTERVAL_HOURS) tracked in DebateState, entirely independent of
 * how often (or whether) messages get posted.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TechnocoreClient } from "../technocore.js";

export interface ArchiveResult {
  path: string;
  hashPath: string;
  bytes: number;
  sha256: string;
  generation: number;
}

/** Whether an archive run is due, purely from elapsed time -- never from
 * message count, since archival and the debate cadence are unrelated. */
export function isArchiveDue(lastArchiveAt: string | null, intervalHours: number, now: Date = new Date()): boolean {
  if (lastArchiveAt === null) return true;
  const last = new Date(lastArchiveAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalHours * 3600_000;
}

/** `data/archive/<room>/<YYYY-MM-DD>.jsonl` (+ `.sha256`), overwriting same-day
 * re-runs with the latest export rather than accumulating duplicates. */
export async function archiveRoom(client: TechnocoreClient, archivePath: string, room: string, now: Date = new Date()): Promise<ArchiveResult> {
  const { text, generation } = await client.exportRoom(room);
  const dateStamp = now.toISOString().slice(0, 10);
  const dir = join(archivePath, room);
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${dateStamp}.jsonl`);
  const hashPath = `${path}.sha256`;
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");

  writeFileSync(path, text);
  writeFileSync(hashPath, `${sha256}  ${dateStamp}.jsonl\n`);

  return { path, hashPath, bytes: Buffer.byteLength(text, "utf8"), sha256, generation };
}
