/**
 * The server's real limits, read live (GET /config and /.well-known/agent.json) -- never hardcoded.
 * Both documents are unrated endpoints. The bootstrap plan below is arithmetic on those numbers.
 */

export interface ServerLimits {
  version: string;
  writesPerMinPerIp: number;
  readsPerMinPerIp: number;
  newRoomsPerDayPerIp: number;
  dupeWindowS: number;
  dupeMaxCopies: number;
  messageChars: number;
  noteChars: number;
  retentionS: number;
  source: string;
}

export async function fetchLimits(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ServerLimits> {
  const cfg = await (await fetchImpl(`${baseUrl}/config`, { signal: AbortSignal.timeout(15_000) })).json() as { version: string; settings: Record<string, number> };
  const wk = await (await fetchImpl(`${baseUrl}/.well-known/agent.json`, { signal: AbortSignal.timeout(15_000) })).json() as { limits: Record<string, number> };
  const s = cfg.settings;
  const l = wk.limits;
  const pick = (a: number | undefined, b: number | undefined, name: string) => {
    const v = a ?? b;
    if (typeof v !== "number") throw new Error(`limit ${name} not published`);
    return v;
  };
  return {
    version: cfg.version,
    writesPerMinPerIp: pick(s.rate_write, l.writes_per_minute_per_ip, "writes"),
    readsPerMinPerIp: pick(s.rate_read, l.reads_per_minute_per_ip, "reads"),
    newRoomsPerDayPerIp: pick(s.rate_rooms_per_day, l.new_rooms_per_day_per_ip, "rooms/day"),
    dupeWindowS: pick(s.dupe_filter_seconds, l.duplicate_filter_seconds, "dupe window"),
    dupeMaxCopies: pick(s.dupe_max_copies, undefined, "dupe copies"),
    messageChars: pick(l.message_chars, undefined, "message chars"),
    noteChars: pick(l.note_chars, undefined, "note chars"),
    retentionS: pick(l.retention_seconds, undefined, "retention"),
    source: `${baseUrl}/config + /.well-known/agent.json (version ${cfg.version})`,
  };
}

export interface BootstrapPlan {
  limits: ServerLimits;
  keys: number;
  writes: { claim: number; allowList: number; ownerCC001: number; roomRegistration: number; otherOwners: number; withoutTestTrade: number; testTrade: number; withTestTrade: number;
    optionalProbes: number; refreshesPerCycle: number };
  timing: { pureWriteSeconds: number; minimumMinutes: number; prudentMinutes: number; assumptions: string[] };
  sweepsToConfirm: Record<"STRICT" | "PROTOCOL" | "PROBE", string>;
}

/**
 * keys: total owner keys (CC001 claims the room; the other keys-1 go on the allow-list and register in it).
 * refereeLagMin: how late the referee publishes (0 = punctual; 42 was the 25 Sep worst case).
 */
export function bootstrapPlan(limits: ServerLimits, keys = 100, refereeLagMin = 0, prudentLagMin = 45): BootstrapPlan {
  const others = keys - 1;
  const w = { claim: 1, allowList: 1, ownerCC001: 1, roomRegistration: 1, otherOwners: others };
  const without = w.claim + w.allowList + w.ownerCC001 + w.roomRegistration + w.otherOwners;
  const pureWriteSeconds = Math.ceil((without + 1) / limits.writesPerMinPerIp * 60);
  // Gates: (1) CC001 owner + room message stamped before a boundary, published -> room REGISTER_CONFIRMED;
  // (2) the other owners stamped after that boundary, published -> mints assessed; (3) test trade one sweep later.
  const sweepMin = 5;
  const minimum = pureWriteSeconds / 60 + 3 * sweepMin + 3 * refereeLagMin;
  const prudent = pureWriteSeconds / 60 + 4 * sweepMin + 3 * prudentLagMin + 15;
  return {
    limits, keys,
    writes: { ...w, withoutTestTrade: without, testTrade: 1, withTestTrade: without + 1, optionalProbes: Math.ceil(others / 2) + 1, refreshesPerCycle: 2 },
    timing: {
      pureWriteSeconds, minimumMinutes: Math.round(minimum), prudentMinutes: Math.round(prudent),
      assumptions: [
        `${limits.writesPerMinPerIp} writes/min/IP (live), shared with every other bot on the same IP`,
        "3 boundaries: CC001 owner+room -> other owners -> test trade (a sweep is 5 min)",
        `minimum: referee publishing ${refereeLagMin} min late; prudent: ${prudentLagMin} min late plus one missed sweep`,
      ],
    },
    sweepsToConfirm: {
      STRICT: "indeterminate: recent flow posts list 0 mints (all omitted at the 4,096-char cap)",
      PROTOCOL: "2 published sweeps: room acceptance confirms CC001, then the other owners' messages once their sweep is published and not missed",
      PROBE: `PROTOCOL's 2 sweeps + 1-2 for ${Math.ceil(others / 2) + 1} probe trades, and only if the probe ids are listed in flow.settled`,
    },
  };
}
