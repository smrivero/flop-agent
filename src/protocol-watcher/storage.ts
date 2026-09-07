/**
 * Content-addressed storage for raw and normalized document bodies:
 * `<contentDir>/<sha256>.raw` / `<contentDir>/<sha256>.norm.txt`. The hash
 * *is* the filename, so two snapshots (even across different sources, or the
 * same source on two different days) that happen to produce byte-identical
 * content automatically share one file on disk -- "dedup by hash" falls out
 * of the naming scheme for free, no separate blob table needed.
 *
 * Retention (see database.ts findPrunableSnapshots/deleteSnapshots) only
 * ever deletes a file after confirming, via referencedContentHashes(db), that
 * no remaining snapshot row still points at that hash -- never based on file
 * age alone.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ContentKind = "raw" | "normalized";

function extensionFor(kind: ContentKind): string {
  return kind === "raw" ? ".raw" : ".norm.txt";
}

function pathFor(contentDir: string, hash: string, kind: ContentKind): string {
  return join(contentDir, `${hash}${extensionFor(kind)}`);
}

/** Writes the content under its hash if not already present; returns the
 * path either way. A no-op disk write when the hash already exists (dedup). */
export function storeContent(contentDir: string, hash: string, kind: ContentKind, content: string): string {
  mkdirSync(contentDir, { recursive: true });
  const path = pathFor(contentDir, hash, kind);
  if (!existsSync(path)) writeFileSync(path, content, "utf8");
  return path;
}

const HASH_FROM_FILENAME_RE = /^([0-9a-f]{64})\.(raw|norm\.txt)$/;

export interface RetentionSweepResult {
  deletedPaths: string[];
  scanned: number;
}

/**
 * Deletes content files whose hash is no longer referenced by any snapshot
 * row (per `referencedHashes`) AND whose age exceeds `retentionDays`. A file
 * still referenced is kept regardless of age -- retention only ever removes
 * data nothing active points at.
 */
export function sweepOrphanedContent(contentDir: string, referencedHashes: Set<string>, retentionDays: number): RetentionSweepResult {
  if (!existsSync(contentDir)) return { deletedPaths: [], scanned: 0 };

  const cutoffMs = Date.now() - retentionDays * 86_400_000;
  const deletedPaths: string[] = [];
  const entries = readdirSync(contentDir);

  for (const entry of entries) {
    const match = HASH_FROM_FILENAME_RE.exec(entry);
    if (!match) continue; // not one of ours -- never touch unrecognized files
    const hash = match[1];
    if (referencedHashes.has(hash)) continue;

    const fullPath = join(contentDir, entry);
    const stat = statSync(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      unlinkSync(fullPath);
      deletedPaths.push(fullPath);
    }
  }

  return { deletedPaths, scanned: entries.length };
}
