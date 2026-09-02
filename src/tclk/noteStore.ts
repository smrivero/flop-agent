/**
 * Adapts the existing `TechnocoreClient` (readNote/writeNote, unchanged protocol
 * logic) to tclk's `NoteStore` interface, so `PaperRail` can run against the real
 * Technocore `/kv/` surface without this project inventing its own settlement
 * bookkeeping. No new HTTP logic here -- just the interface shape tclk expects.
 */

import type { NoteStore } from "@flop-labs/tclk";
import { TechnocoreClient } from "../technocore.js";

export function technocoreNoteStore(client: TechnocoreClient): NoteStore {
  return {
    async get(ns: string, key: string): Promise<string | null> {
      return client.readNote(ns, key);
    },
    async set(
      ns: string,
      key: string,
      value: string,
      condition?: { ifAbsent: true } | { if: string },
    ): Promise<boolean> {
      if (condition === undefined) return client.writeNote(ns, key, value);
      if ("ifAbsent" in condition) return client.writeNote(ns, key, value, { ifAbsent: true });
      return client.writeNote(ns, key, value, { ifEquals: condition.if });
    },
  };
}
