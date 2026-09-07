/**
 * Shared types for the FLOP Protocol Watcher. Mirrors the shapes requested for
 * this feature (OpenItem, ImplementationItem, ProtocolChange) plus the
 * internal types the pipeline stages pass to each other.
 */

export type SourceKind = "html-flop" | "markdown-tclk";

export interface ProtocolSource {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  enabled: boolean;
}

// -- extraction ---------------------------------------------------------------

export type ExtractionCategory =
  | "metadata"
  | "tokenomics"
  | "agent"
  | "validator"
  | "verification"
  | "open_item"
  | "implementation"
  | "other";

export type ExtractionStatus = "ok" | "partial" | "failed";

/** One row's worth of extracted data -- persisted 1:1 into `protocol_extractions`. */
export interface ExtractionItem {
  category: ExtractionCategory;
  itemKey: string;
  value: unknown;
  sourceSection?: string;
  status: ExtractionStatus;
  error?: string;
}

export interface ExtractionResult {
  items: ExtractionItem[];
  /** Non-fatal problems encountered while extracting (e.g. one appendix
   * missing from a page that doesn't have it) -- never thrown, always
   * reported alongside whatever *did* extract successfully. */
  warnings: string[];
}

/** Requested exact shape. */
export interface OpenItem {
  id: string;
  title: string;
  status: string;
  summary: string;
  placeholder?: string;
  blockers: string[];
  sourceSection: string;
}

export type ImplementationStatus = "LIVE" | "PARTIAL" | "PLANNED" | "GAP" | "OOS" | "UNKNOWN";

/** Requested exact shape. */
export interface ImplementationItem {
  area: string;
  requirement: string;
  section: string;
  status: ImplementationStatus;
  codePath?: string;
  tracker?: string;
}

export interface DocumentMetadata {
  name?: string;
  version?: string;
  status?: string;
  updatedAt?: string;
  draftBannerText?: string;
}

// -- changes --------------------------------------------------------------------

export type ProtocolChangeCategory =
  | "airdrop"
  | "testnet"
  | "agent"
  | "validator"
  | "verification"
  | "settlement"
  | "tclk"
  | "tokenomics"
  | "implementation"
  | "other";

export type ProtocolChangeType = "added" | "removed" | "modified";

export type ProtocolChangeSeverity = "info" | "important" | "action_required";

/** Requested exact shape. */
export interface ProtocolChange {
  sourceId: string;
  documentVersionBefore?: string;
  documentVersionAfter?: string;
  detectedAt: string;
  category: ProtocolChangeCategory;
  itemId?: string;
  field?: string;
  previousValue?: unknown;
  currentValue?: unknown;
  changeType: ProtocolChangeType;
  severity: ProtocolChangeSeverity;
  evidence: {
    url: string;
    section?: string;
    beforeText?: string;
    afterText?: string;
  };
}

// -- events -----------------------------------------------------------------

export type ProtocolEventType =
  | "FLOP_DOCUMENT_CHANGED"
  | "FLOP_AIRDROP_RULES_CHANGED"
  | "FLOP_AGENT_SCORING_RATIFIED"
  | "FLOP_VALIDATOR_REQUIREMENTS_CHANGED"
  | "FLOP_TESTNET_DATE_CHANGED"
  | "FLOP_TESTNET_ENDPOINT_AVAILABLE"
  | "FLOP_INFERENCE_INTERFACE_AVAILABLE"
  | "FLOP_SPEND_TO_UNLOCK_CHANGED"
  | "FLOP_TCLK_RAIL_AVAILABLE"
  | "FLOP_IMPLEMENTATION_STATUS_CHANGED";

export interface ProtocolEvent {
  eventType: ProtocolEventType;
  sourceId: string;
  snapshotId?: number;
  changeBatchId: string;
  severity: ProtocolChangeSeverity;
  payload: Record<string, unknown>;
}

// -- fetch --------------------------------------------------------------------

export interface FetchOutcome {
  sourceId: string;
  url: string;
  /** True when the server returned 304 against our cached ETag/Last-Modified
   * -- no body was downloaded, no snapshot is created. */
  notModified: boolean;
  httpStatus: number;
  etag?: string;
  lastModified?: string;
  rawBody?: string;
  contentType?: string;
  error?: string;
}
