/**
 * Structural diff between two extraction sets (previous snapshot vs. current
 * snapshot), keyed by `${category}::${itemKey}` -- not a text diff of the
 * whole document. Values are compared via a deterministic JSON
 * serialization (every extractor builds its value objects with a fixed key
 * order, so this is stable run to run for identical content).
 */

import type { ExtractionCategory, ExtractionItem } from "./types.js";

export interface ExtractionSnapshotEntry {
  category: ExtractionCategory;
  itemKey: string;
  value: unknown;
  sourceSection?: string;
}

export type ExtractionChangeType = "added" | "removed" | "modified";

export interface ExtractionDiffEntry {
  category: ExtractionCategory;
  itemKey: string;
  changeType: ExtractionChangeType;
  previousValue?: unknown;
  currentValue?: unknown;
  sourceSection?: string;
}

function key(category: string, itemKey: string): string {
  return `${category}::${itemKey}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function toSnapshotEntries(items: ExtractionItem[]): Map<string, ExtractionSnapshotEntry> {
  const map = new Map<string, ExtractionSnapshotEntry>();
  for (const item of items) {
    map.set(key(item.category, item.itemKey), {
      category: item.category,
      itemKey: item.itemKey,
      value: item.value,
      sourceSection: item.sourceSection,
    });
  }
  return map;
}

export function diffExtractions(
  previous: Map<string, ExtractionSnapshotEntry>,
  current: Map<string, ExtractionSnapshotEntry>,
): ExtractionDiffEntry[] {
  const entries: ExtractionDiffEntry[] = [];
  const allKeys = new Set([...previous.keys(), ...current.keys()]);

  for (const k of allKeys) {
    const before = previous.get(k);
    const after = current.get(k);

    if (before && !after) {
      entries.push({ category: before.category, itemKey: before.itemKey, changeType: "removed", previousValue: before.value, sourceSection: before.sourceSection });
    } else if (!before && after) {
      entries.push({ category: after.category, itemKey: after.itemKey, changeType: "added", currentValue: after.value, sourceSection: after.sourceSection });
    } else if (before && after && stableStringify(before.value) !== stableStringify(after.value)) {
      entries.push({
        category: after.category,
        itemKey: after.itemKey,
        changeType: "modified",
        previousValue: before.value,
        currentValue: after.value,
        sourceSection: after.sourceSection ?? before.sourceSection,
      });
    }
  }

  // Deterministic order: same input always yields the same change list/order.
  entries.sort((a, b) => (a.category === b.category ? a.itemKey.localeCompare(b.itemKey) : a.category.localeCompare(b.category)));
  return entries;
}
