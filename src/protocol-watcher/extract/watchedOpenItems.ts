/** Open Specification Items called out by name as needing special attention
 * (surfaced distinctly in `protocol:status` and boosted to at least
 * "important" severity on any status change -- see classify.ts). */
export const WATCHED_OPEN_ITEM_IDS: readonly string[] = [
  "E.35",
  "E.38",
  "E.39",
  "E.40",
  "E.42",
  "E.43",
  "E.44",
  "E.45",
  "E.46",
  "E.49",
];

export function isWatchedOpenItem(id: string): boolean {
  return WATCHED_OPEN_ITEM_IDS.includes(id);
}
