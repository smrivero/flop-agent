/**
 * `protocol:status` -- everything read from the local database only, never
 * from the network (per the "status must not re-download pages" rule). Pure
 * data-building here; cli.ts does the text rendering.
 */

import type { ProtocolWatcherDb } from "./database.js";
import { listSources, getLatestSnapshot, getExtractions, getLatestChanges, getRecentNotifications } from "./database.js";
import { WATCHED_OPEN_ITEM_IDS } from "./extract/watchedOpenItems.js";
import type { OpenItem, ExtractionCategory } from "./types.js";

export interface SourceStatusEntry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastAttemptedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  declaredVersion: string | null;
  declaredUpdatedAt: string | null;
  normalizedHashShort: string | null;
  lastSnapshotAt: string | null;
  extractionCounts: Partial<Record<ExtractionCategory, number>>;
  lastChange?: { field: string | null; severity: string; detectedAt: string };
}

export interface WatchedOpenItemStatus {
  id: string;
  found: boolean;
  status?: string;
  title?: string;
  sourceId?: string;
}

export interface StatusReport {
  sources: SourceStatusEntry[];
  watchedOpenItems: WatchedOpenItemStatus[];
  recentNotifications: ReturnType<typeof getRecentNotifications>;
}

function extractionCountsFor(db: ProtocolWatcherDb, snapshotId: number): Partial<Record<ExtractionCategory, number>> {
  const rows = getExtractions(db, snapshotId);
  const counts: Partial<Record<ExtractionCategory, number>> = {};
  for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1;
  return counts;
}

export function buildStatusReport(db: ProtocolWatcherDb): StatusReport {
  const sources = listSources(db).map((s): SourceStatusEntry => {
    const latest = getLatestSnapshot(db, s.id);
    const lastChangeRow = getLatestChanges(db, s.id, 1)[0];
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled === 1,
      lastAttemptedAt: s.last_attempted_at,
      lastSuccessAt: s.last_success_at,
      consecutiveErrors: s.consecutive_errors,
      lastError: s.last_error,
      declaredVersion: latest?.declared_version ?? null,
      declaredUpdatedAt: latest?.declared_updated_at ?? null,
      normalizedHashShort: latest ? latest.normalized_hash.slice(0, 12) : null,
      lastSnapshotAt: latest?.fetched_at ?? null,
      extractionCounts: latest ? extractionCountsFor(db, latest.id) : {},
      lastChange: lastChangeRow ? { field: lastChangeRow.field, severity: lastChangeRow.severity, detectedAt: lastChangeRow.detected_at } : undefined,
    };
  });

  const watchedOpenItems: WatchedOpenItemStatus[] = WATCHED_OPEN_ITEM_IDS.map((id) => {
    for (const s of listSources(db)) {
      const latest = getLatestSnapshot(db, s.id);
      if (!latest) continue;
      const row = getExtractions(db, latest.id).find((r) => r.category === "open_item" && r.item_key === id);
      if (row) {
        const value = JSON.parse(row.value_json) as OpenItem;
        return { id, found: true, status: value.status, title: value.title, sourceId: s.id };
      }
    }
    return { id, found: false };
  });

  return { sources, watchedOpenItems, recentNotifications: getRecentNotifications(db, 10) };
}
