export interface AgentSpec {
  name: string;
  position: string;
  personalityFile: string;
}

export interface DebateDefinition {
  room: string;
  topic: string;
  language: string;
  agentA: AgentSpec;
  agentB: AgentSpec;
}

/** Only "openai" is implemented today. The type is a union of one so adding a
 * second provider (e.g. "flop") is a type-checked, one-place change -- see
 * inference.ts for the extension point this exists for. */
export type InferenceProviderName = "openai";

export interface DebateConfig {
  inferenceProvider: InferenceProviderName;

  openAiApiKey: string;
  openAiModel: string;
  openAiMaxOutputTokens: number;
  webSearchEnabled: boolean;
  /** When true (and webSearchEnabled), tool_choice is forced to "required" and
   * a turn whose response contains no web_search_call is rejected rather than
   * published. */
  webSearchRequired: boolean;

  technocoreBaseUrl: string;

  agentAIdentityPath: string;
  agentBIdentityPath: string;

  debateConfigPath: string;

  minDelaySeconds: number;
  maxDelaySeconds: number;
  /** Hard cap on published debate messages per UTC day. Once reached, no more
   * turns are generated until the day rolls over -- no burst catch-up. */
  maxMessagesPerDay: number;
  /** When true, the model may return exactly "SKIP" instead of a message; the
   * turn is then logged and not published, and does not count toward
   * maxMessagesPerDay. */
  allowSkipTurn: boolean;
  historyMessages: number;
  maxMessageChars: number;

  /** Jaccard word-trigram similarity, 0-1, above which a draft is considered a
   * repeat of the same agent's own recent messages and gets one regeneration. */
  repetitionThreshold: number;
  /** How many of the same agent's own recent messages the repetition check
   * compares a fresh draft against. */
  recentMessagesForSimilarity: number;

  checkpointEnabled: boolean;
  /** Every Nth successfully published debate message (skips don't count) is
   * replaced by a locally-formatted checkpoint instead of a generated reply. */
  checkpointEveryMessages: number;

  archiveEnabled: boolean;
  archiveIntervalHours: number;

  identityMaintenanceEnabled: boolean;
  identityRefreshHours: number;

  httpTimeoutMs: number;
  maxRetries: number;

  logLevel: "debug" | "info" | "warn" | "error";

  statePath: string;
  lockPath: string;
  archivePath: string;
}

export type AgentId = "A" | "B";

export interface LoadedAgent {
  id: AgentId;
  name: string;
  position: string;
  opponentName: string;
  opponentPosition: string;
  personality: string;
  did: string;
  sign(canonicalMessage: string): string;
}

/** A room message already filtered down to "signed by one of our two agents". */
export interface DebateTurn {
  seq: number;
  agentId: AgentId;
  did: string;
  text: string;
  ts: string;
}

export type ClaimStatus = "unverified" | "verified" | "disputed" | "corrected";

/**
 * One factual claim surfaced during the debate, as reported by the model
 * itself in a machine-readable trailer (see claims.ts) -- not independently
 * re-derived by this code. `verifiedBy` is set only once `status` moves past
 * "unverified": the agent whose turn produced that judgement.
 */
export interface ClaimRecord {
  /** `claim-0001`, sequential, assigned locally (see state.ts nextClaimId). */
  id: string;
  author: AgentId;
  claim: string;
  status: ClaimStatus;
  verifiedBy?: AgentId;
  sources: string[];
}

/** Lifetime counts of claims that reached each terminal status -- kept
 * separately from the bounded `claimRecords` list so a checkpoint's totals
 * don't shrink just because old entries aged out of that bounded window. */
export interface ClaimStats {
  verified: number;
  disputed: number;
  corrected: number;
}

export interface DebateState {
  room: string;
  lastProcessedSeq: number;
  lastSpeakerDid: string | null;
  totalMessages: number;
  /** Bounded, most-recent-first. Short strings only -- this is a memory aid for
   * the prompt, not a transcript (the transcript is Technocore itself). */
  recentTopics: string[];
  recentClaims: string[];
  recentSources: string[];

  /** UTC calendar day (YYYY-MM-DD) the daily message counter below applies to.
   * Reset (and messagesToday zeroed) the first time a turn runs on a new day. */
  currentDay: string;
  /** Successfully PUBLISHED debate messages so far today (UTC). Skipped turns
   * never increment this. */
  messagesToday: number;

  /** Bounded, most-recent-first structured claim history -- see ClaimRecord. */
  claimRecords: ClaimRecord[];
  claimStats: ClaimStats;
  /** Monotonic counter behind ClaimRecord ids -- never reused, even if older
   * records age out of the bounded claimRecords list. */
  claimCounter: number;

  /** How many successfully published messages (checkpoints included) since
   * the last checkpoint -- used to decide when the next one is due. */
  messagesSinceCheckpoint: number;
  checkpointCount: number;

  lastArchiveAt: string | null;
  lastIdentityRefreshA: string | null;
  lastIdentityRefreshB: string | null;

  updatedAt: string;
}
