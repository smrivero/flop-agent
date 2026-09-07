/**
 * Loads the monitored-URL registry from config/protocol-sources.yaml (path
 * configurable via PROTOCOL_WATCHER_SOURCES_PATH, see config.ts). URLs never
 * live as string literals anywhere else in this feature -- every fetch call
 * traces back to a ProtocolSource loaded here.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ProtocolSource, SourceKind } from "./types.js";

export class ProtocolSourcesError extends Error {}

const VALID_KINDS: SourceKind[] = ["html-flop", "markdown-tclk"];

function assertString(value: unknown, field: string, sourceIndex: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProtocolSourcesError(`sources[${sourceIndex}].${field} must be a non-empty string`);
  }
  return value;
}

export function loadProtocolSources(path: string): ProtocolSource[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ProtocolSourcesError(`could not read sources file at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ProtocolSourcesError(`could not parse YAML in ${path}: ${(err as Error).message}`);
  }

  const list = (parsed as { sources?: unknown[] } | null)?.sources;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ProtocolSourcesError(`${path} must define a non-empty top-level "sources" list`);
  }

  const seenIds = new Set<string>();
  const sources: ProtocolSource[] = list.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ProtocolSourcesError(`sources[${index}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const id = assertString(e.id, "id", index);
    if (seenIds.has(id)) throw new ProtocolSourcesError(`duplicate source id ${JSON.stringify(id)} in ${path}`);
    seenIds.add(id);

    const name = assertString(e.name, "name", index);
    const url = assertString(e.url, "url", index);
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new ProtocolSourcesError(`sources[${index}].url is not a valid URL: ${JSON.stringify(url)}`);
    }

    const kind = assertString(e.kind, "kind", index) as SourceKind;
    if (!VALID_KINDS.includes(kind)) {
      throw new ProtocolSourcesError(`sources[${index}].kind must be one of ${VALID_KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
    }

    const enabled = e.enabled === undefined ? true : Boolean(e.enabled);

    return { id, name, url, kind, enabled };
  });

  return sources;
}

export function enabledSources(sources: ProtocolSource[]): ProtocolSource[] {
  return sources.filter((s) => s.enabled);
}
