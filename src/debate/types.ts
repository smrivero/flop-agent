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

export interface DebateConfig {
  openAiApiKey: string;
  openAiModel: string;
  openAiMaxOutputTokens: number;
  webSearchEnabled: boolean;

  technocoreBaseUrl: string;

  agentAIdentityPath: string;
  agentBIdentityPath: string;

  debateConfigPath: string;

  minDelaySeconds: number;
  maxDelaySeconds: number;
  historyMessages: number;
  maxMessageChars: number;

  httpTimeoutMs: number;
  maxRetries: number;

  logLevel: "debug" | "info" | "warn" | "error";

  statePath: string;
  lockPath: string;
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
  updatedAt: string;
}
