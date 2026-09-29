/**
 * All `closecall:*` configuration, read once from process.env (same convention as
 * src/sonnet/config.ts and src/mentions/config.ts: nothing else in this feature
 * reads process.env).
 *
 * MODES. Default is `paper`. `observe` and `dry-run` are read-only too. `live`
 * needs TWO deliberate settings -- CLOSECALL_MODE=live AND
 * CLOSECALL_LIVE_ENABLED=<LIVE_ACK, exactly> -- and if either is missing the
 * process refuses to start (no write, ever). Even with both, THIS BUILD refuses:
 * the live writer is not connected (see live/README and guard.test.ts).
 *
 * Persistent layout (never deleted by deploys): data/close-call/
 *   close-call.sqlite3   state, journal, alerts        logs/     JSON logs (rotated)
 *   keys/                future key files (700 / 600)   backups/  DB + encrypted key backups
 *   closecall.lock       single-instance lock
 */

import { resolve } from "node:path";

export class CloseCallConfigError extends Error {}

export type Mode = "paper" | "observe" | "dry-run" | "live";
export type EstimatorSource = "ref" | "hl" | "combined";
export type UntilPolicy = "this-sweep" | "next-sweep";
export type ConfirmationPolicy = "STRICT" | "PROTOCOL" | "PROBE";
export type StaleMode = "adaptive" | "TRADE" | "REDUCE" | "HALT_NEW_ENTRIES";

/** The exact acknowledgement CLOSECALL_LIVE_ENABLED must carry for live mode to even be considered. */
export const LIVE_ACK = "I-UNDERSTAND-CLOSECALL-LIVE-SIGNS-AND-POSTS-REAL-MESSAGES";

export interface StrategyKConfig {
  keyCount: number;
  /** New pair when the price is `threshold` beyond the last used low/high (0.0025 = 0.25%). */
  threshold: number;
  /** Extra distance past the fee-neutral price, as a fraction (0.001 = 0.1%). */
  priceMargin: number;
  /** Size so the funds check survives a close this far from the estimate (0.003 = 0.3%). */
  qtyMargin: number;
  /** Cash kept unspent by each side, as a fraction of its cash (0 = all-in). */
  reserve: number;
  untilPolicy: UntilPolicy;
}

/**
 * CONTRA (strategy/contra.ts), a module separate from Strategy K. The reserved keys are taken out of K's key list
 * whenever `keys` is set (so they stay virgin while the operator decides); CONTRA trades only when `enabled`.
 */
export interface ContraConfig {
  /** Kill switch, independent of the live writer: no CONTRA intent unless true (default false). */
  enabled: boolean;
  /** Reserved keys, in order: champion LONG, its counterparties, champion SHORT, its counterparties. [] = none. */
  keys: string[];
  /**
   * Per champion (named by its START direction): take profit and reverse when the estimate moves this far in its
   * favour (0.0025 = 0.25%). CLOSECALL_CONTRA_THRESHOLD sets both; _THRESHOLD_LONG / _THRESHOLD_SHORT override one.
   */
  threshold: { long: number; short: number };
  /** Counterparties per champion (each leg burns one, never reused). _COUNTERPARTIES sets both; _LONG / _SHORT override. */
  counterparties: { long: number; short: number };
  /**
   * Cash each side keeps unspent on an OPEN/REOPEN leg (0.04 = 4%). An all-in champion could not pay the fee of its
   * own close (~1.1% of the position), and a fresh counterparty buying the close ~2.4% above the entry price could not
   * take the whole position: without this reserve the close is partial and the reopen becomes a flip (refused).
   */
  reserve: number;
}

export interface StalePolicyConfig {
  mode: StaleMode;
  /** adaptive: referee age_s at or above this -> REDUCE (wider margins). */
  reduceAgeS: number;
  /** adaptive: referee age_s at or above this -> HALT_NEW_ENTRIES. */
  haltAgeS: number;
  /** adaptive: publication delay (minutes) at or above this -> HALT_NEW_ENTRIES. */
  haltDelayMin: number;
  /** adaptive: |Hyperliquid - referee ref| above this (bps) while stale -> HALT_NEW_ENTRIES. */
  haltDivergenceBps: number;
}

export interface CloseCallConfig {
  mode: Mode;
  technocoreBaseUrl: string;
  hyperliquidInfoUrl: string;
  hyperliquidCoin: string;
  vendorRoot: string;
  dataDir: string;
  dbPath: string;
  rawLogDir: string;
  logDir: string;
  keysDir: string;
  backupDir: string;
  lockPath: string;
  python: string;
  refereePollMs: number;
  hlPollMs: number;
  decisionLeadMs: number;
  estimator: EstimatorSource;
  hlStaleMs: number;
  refereeStaleAgeS: number;
  strategy: StrategyKConfig;
  contra: ContraConfig;
  stalePriceMargin: number;
  staleQtyMargin: number;
  stalePolicy: StalePolicyConfig;
  confirmationPolicy: ConfirmationPolicy;
  /** Safe mode: halt execution when the referee's last post is older than this (seconds since it was received). */
  haltRefereeSilenceS: number;
  /** Safe mode: halt execution when Hyperliquid's last trade is older than this. */
  haltHlStaleMs: number;
  roomRefreshDays: number;
  diskLowMb: number;
  health: { enabled: boolean; host: string; port: number };
  logs: { maxFileMb: number; maxTotalMb: number; retentionDays: number };
  alerts: { webhookUrl: string | null; telegramBotToken: string | null; telegramChatId: string | null; minIntervalS: number };
  paperKeyPrefix: string;
  /** Real keys and the live bootstrap keep their own database: a paper DB (fake keys) never holds a real key. */
  liveDbPath: string;
  /** Our owned trading room (`d-...`), or null until the operator picks one. */
  room: string | null;
  /** age public key (age1...) the key backup is encrypted to. Its identity (private) lives only on the operator's Mac. */
  backupAgeRecipient: string | null;
  /** Fraction of the live per-IP write limit the bootstrap may use (the IP is shared with other bots). */
  writeBudgetFraction: number;
  /** Live: no trade is posted later than this many ms before its sweep's boundary. */
  postGuardMs: number;
  /** The live writer is compiled in and connected; it writes ONLY when this is "armed" (and no DISARM kill switch file). */
  liveWriter: "armed" | "disarmed";
  /** Live: at most this many trade POSTs per sweep (Strategy K rarely needs more than 2). */
  maxTradesPerSweep: number;
}

function num(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new CloseCallConfigError(`${name} must be a number in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return v;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], def: T): T {
  const raw = env[name]?.trim();
  if (!raw) return def;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new CloseCallConfigError(`${name} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

function bool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return def;
  return raw === "true" || raw === "1" || raw === "yes";
}

export function loadCloseCallConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): CloseCallConfig {
  const modeRaw = env.CLOSECALL_MODE?.trim() || "paper";
  if (!["observe", "paper", "dry-run", "live"].includes(modeRaw)) {
    throw new CloseCallConfigError(`CLOSECALL_MODE must be paper | observe | dry-run | live, got ${JSON.stringify(modeRaw)}`);
  }
  if (modeRaw === "live" && env.CLOSECALL_LIVE_ENABLED !== LIVE_ACK) {
    throw new CloseCallConfigError("CLOSECALL_MODE=live without CLOSECALL_LIVE_ENABLED set to the exact acknowledgement: refusing to start (NO WRITE).");
  }
  if (modeRaw !== "live" && env.CLOSECALL_LIVE_ENABLED) {
    throw new CloseCallConfigError("CLOSECALL_LIVE_ENABLED is set but CLOSECALL_MODE is not live: remove it so the two can never disagree.");
  }
  if (env.CLOSECALL_LIVE_WRITER?.trim() === "armed" && modeRaw !== "live") {
    throw new CloseCallConfigError("CLOSECALL_LIVE_WRITER=armed is only valid with CLOSECALL_MODE=live (paper can never write)");
  }
  const keyCount = num(env, "CLOSECALL_KEY_COUNT", 100, 2, 100);
  if (keyCount % 2 !== 0) throw new CloseCallConfigError("CLOSECALL_KEY_COUNT must be even (keys trade in pairs)");
  const dataDir = resolve(cwd, env.CLOSECALL_DATA_DIR?.trim() || "data/close-call");
  const healthHost = env.CLOSECALL_HEALTH_HOST?.trim() || "127.0.0.1";
  if (healthHost === "0.0.0.0" && !bool(env, "CLOSECALL_HEALTH_ALLOW_PUBLIC", false)) {
    throw new CloseCallConfigError("CLOSECALL_HEALTH_HOST=0.0.0.0 needs CLOSECALL_HEALTH_ALLOW_PUBLIC=true; use an SSH tunnel instead.");
  }
  return {
    mode: modeRaw as Mode,
    technocoreBaseUrl: env.CLOSECALL_TECHNOCORE_URL?.trim() || env.TECHNOCORE_URL?.trim() || "https://technocore.chat",
    hyperliquidInfoUrl: env.CLOSECALL_HL_INFO_URL?.trim() || "https://api.hyperliquid.xyz/info",
    hyperliquidCoin: "xyz:NVDA",
    vendorRoot: resolve(cwd, env.CLOSECALL_VENDOR_ROOT?.trim() || "vendor/technocore-close-call"),
    dataDir,
    dbPath: resolve(cwd, env.CLOSECALL_DB_PATH?.trim() || resolve(dataDir, "close-call.sqlite3")),
    rawLogDir: resolve(cwd, env.CLOSECALL_RAW_DIR?.trim() || resolve(dataDir, "logs")),
    logDir: resolve(cwd, env.CLOSECALL_LOG_DIR?.trim() || resolve(dataDir, "logs")),
    keysDir: resolve(cwd, env.CLOSECALL_KEYS_DIR?.trim() || resolve(dataDir, "keys")),
    backupDir: resolve(cwd, env.CLOSECALL_BACKUP_DIR?.trim() || resolve(dataDir, "backups")),
    lockPath: resolve(cwd, env.CLOSECALL_LOCK_PATH?.trim() || resolve(dataDir, "closecall.lock")),
    python: env.CLOSECALL_PYTHON?.trim() || "python3",
    refereePollMs: num(env, "CLOSECALL_REFEREE_POLL_MS", 10_000, 2_000, 120_000),
    hlPollMs: num(env, "CLOSECALL_HL_POLL_MS", 3_000, 1_000, 60_000),
    decisionLeadMs: num(env, "CLOSECALL_DECISION_LEAD_MS", 20_000, 3_000, 240_000),
    estimator: oneOf(env, "CLOSECALL_ESTIMATOR", ["ref", "hl", "combined"] as const, "combined"),
    hlStaleMs: num(env, "CLOSECALL_HL_STALE_MS", 60_000, 1_000, 3_600_000),
    refereeStaleAgeS: num(env, "CLOSECALL_REFEREE_STALE_AGE_S", 300, 10, 3_600),
    strategy: {
      keyCount,
      threshold: num(env, "CLOSECALL_THRESHOLD", 0.0025, 0.0005, 0.1),
      priceMargin: num(env, "CLOSECALL_PRICE_MARGIN", 0.001, 0, 0.04),
      qtyMargin: num(env, "CLOSECALL_QTY_MARGIN", 0.003, 0, 0.05),
      reserve: num(env, "CLOSECALL_RESERVE", 0, 0, 0.5),
      untilPolicy: oneOf(env, "CLOSECALL_UNTIL_POLICY", ["this-sweep", "next-sweep"] as const, "this-sweep"),
    },
    contra: contraConfig(env),
    stalePriceMargin: num(env, "CLOSECALL_STALE_PRICE_MARGIN", 0.004, 0, 0.04),
    staleQtyMargin: num(env, "CLOSECALL_STALE_QTY_MARGIN", 0.012, 0, 0.05),
    stalePolicy: {
      mode: oneOf(env, "CLOSECALL_STALE_POLICY", ["adaptive", "TRADE", "REDUCE", "HALT_NEW_ENTRIES"] as const, "adaptive"),
      reduceAgeS: num(env, "CLOSECALL_STALE_REDUCE_AGE_S", 60, 10, 86_400),
      haltAgeS: num(env, "CLOSECALL_STALE_HALT_AGE_S", 300, 10, 86_400),
      haltDelayMin: num(env, "CLOSECALL_STALE_HALT_DELAY_MIN", 45, 1, 1_440),
      haltDivergenceBps: num(env, "CLOSECALL_STALE_HALT_DIVERGENCE_BPS", 50, 1, 5_000),
    },
    // PROTOCOL is the operator's choice for live (26 Sep). STRICT and PROBE stay available for diagnosis / fallback.
    confirmationPolicy: oneOf(env, "CLOSECALL_CONFIRMATION_POLICY", ["STRICT", "PROTOCOL", "PROBE"] as const, "PROTOCOL"),
    haltRefereeSilenceS: num(env, "CLOSECALL_HALT_REFEREE_SILENCE_S", 3_600, 60, 86_400),
    haltHlStaleMs: num(env, "CLOSECALL_HALT_HL_STALE_MS", 600_000, 10_000, 86_400_000),
    roomRefreshDays: num(env, "CLOSECALL_ROOM_REFRESH_DAYS", 5, 1, 6),
    diskLowMb: num(env, "CLOSECALL_DISK_LOW_MB", 500, 10, 1_000_000),
    health: {
      enabled: bool(env, "CLOSECALL_HEALTH_ENABLED", true),
      host: healthHost,
      port: num(env, "CLOSECALL_HEALTH_PORT", 8787, 1024, 65_535),
    },
    logs: {
      maxFileMb: num(env, "CLOSECALL_LOG_MAX_FILE_MB", 20, 1, 1_000),
      maxTotalMb: num(env, "CLOSECALL_LOG_MAX_TOTAL_MB", 500, 10, 100_000),
      retentionDays: num(env, "CLOSECALL_LOG_RETENTION_DAYS", 14, 1, 365),
    },
    alerts: {
      webhookUrl: env.CLOSECALL_ALERT_WEBHOOK_URL?.trim() || null,
      telegramBotToken: env.CLOSECALL_ALERT_TELEGRAM_BOT_TOKEN?.trim() || null,
      telegramChatId: env.CLOSECALL_ALERT_TELEGRAM_CHAT_ID?.trim() || null,
      minIntervalS: num(env, "CLOSECALL_ALERT_MIN_INTERVAL_S", 900, 0, 86_400),
    },
    paperKeyPrefix: "CC",
    liveDbPath: resolve(cwd, env.CLOSECALL_LIVE_DB_PATH?.trim() || resolve(dataDir, "live.sqlite3")),
    room: roomName(env.CLOSECALL_ROOM),
    backupAgeRecipient: ageRecipient(env.CLOSECALL_BACKUP_AGE_RECIPIENT),
    writeBudgetFraction: num(env, "CLOSECALL_WRITE_BUDGET_FRACTION", 0.25, 0.01, 0.9),
    postGuardMs: num(env, "CLOSECALL_POST_GUARD_MS", 3_000, 500, 60_000),
    liveWriter: oneOf(env, "CLOSECALL_LIVE_WRITER", ["armed", "disarmed"] as const, "disarmed"),
    maxTradesPerSweep: num(env, "CLOSECALL_MAX_TRADES_PER_SWEEP", 6, 1, 50),
  };
}

/** CLOSECALL_CONTRA_KEYS=CC061-CC100 (a range) or a comma list; CLOSECALL_CONTRA_ENABLED=true to trade. */
function contraConfig(env: NodeJS.ProcessEnv): ContraConfig {
  const cps = num(env, "CLOSECALL_CONTRA_COUNTERPARTIES", 19, 1, 96);
  const counterparties = { long: num(env, "CLOSECALL_CONTRA_COUNTERPARTIES_LONG", cps, 1, 96), short: num(env, "CLOSECALL_CONTRA_COUNTERPARTIES_SHORT", cps, 1, 96) };
  const x = num(env, "CLOSECALL_CONTRA_THRESHOLD", 0.0025, 0.0005, 0.1);
  const threshold = { long: num(env, "CLOSECALL_CONTRA_THRESHOLD_LONG", x, 0.0005, 0.1), short: num(env, "CLOSECALL_CONTRA_THRESHOLD_SHORT", x, 0.0005, 0.1) };
  const total = 2 + counterparties.long + counterparties.short;
  const raw = env.CLOSECALL_CONTRA_KEYS?.trim() ?? "";
  let keys: string[] = [];
  const range = raw.match(/^CC(\d{3})-CC(\d{3})$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (b < a) throw new CloseCallConfigError(`CLOSECALL_CONTRA_KEYS range is backwards: ${raw}`);
    keys = Array.from({ length: b - a + 1 }, (_, i) => `CC${String(a + i).padStart(3, "0")}`);
  } else if (raw) {
    keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.some((k) => !/^CC\d{3}$/.test(k))) throw new CloseCallConfigError(`CLOSECALL_CONTRA_KEYS must be CCnnn-CCnnn or a CCnnn list, got ${JSON.stringify(raw)}`);
  }
  if (new Set(keys).size !== keys.length) throw new CloseCallConfigError("CLOSECALL_CONTRA_KEYS lists a key twice");
  if (keys.length && keys.length !== total) {
    throw new CloseCallConfigError(`CLOSECALL_CONTRA_KEYS must hold exactly ${total} keys (2 champions + ${counterparties.long} + ${counterparties.short} counterparties), got ${keys.length}`);
  }
  const enabled = bool(env, "CLOSECALL_CONTRA_ENABLED", false);
  if (enabled && !keys.length) throw new CloseCallConfigError("CLOSECALL_CONTRA_ENABLED=true needs CLOSECALL_CONTRA_KEYS");
  const reserve = num(env, "CLOSECALL_CONTRA_RESERVE", 0.04, 0, 0.5);
  return { enabled, keys, threshold, counterparties, reserve };
}

function roomName(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^d-[a-z0-9][a-z0-9_-]{0,45}$/.test(v)) throw new CloseCallConfigError(`CLOSECALL_ROOM must be an ownable d- room name (a-z0-9_-), got ${JSON.stringify(v)}`);
  if (v.startsWith("d-close1")) throw new CloseCallConfigError("CLOSECALL_ROOM must not look like a referee room (d-close1*)");
  return v;
}

function ageRecipient(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^age1[02-9ac-hj-np-z]{58}$/.test(v)) throw new CloseCallConfigError("CLOSECALL_BACKUP_AGE_RECIPIENT must be an age public key (age1..., 62 chars); the private identity never goes on the VPS");
  if (/AGE-SECRET-KEY/i.test(v)) throw new CloseCallConfigError("that is an age SECRET key: it must never be on the VPS");
  return v;
}
