/**
 * All mentions-pipeline configuration in one place, read once from process.env.
 * Nothing else in this feature reads process.env directly -- that keeps every
 * other module testable with plain function arguments.
 */

export class ConfigError extends Error {}

export type SearchProviderName = "tavily" | "searxng";

export interface MentionsConfig {
  searchProvider: SearchProviderName;

  tavilyApiKey?: string;
  tavilySearchDepth: "basic" | "advanced";
  tavilyMaxResults: number;

  searxngUrl: string;

  searchQueries: string[];
  queriesPerRun: number;

  useOpenAi: boolean;
  openAiApiKey?: string;
  openAiModel?: string;
  filterWithOpenAi: boolean;
  generateSummary: boolean;
  maxContentChars: number;

  technocoreRoom: string;

  maxPostsPerRun: number;
  includeOfficialSources: boolean;
  excludedDomains: string[];

  httpTimeoutMs: number;
  maxRetries: number;

  publishIfAnalysisFails: boolean;

  dbPath: string;
  lockPath: string;
}

const DEFAULT_QUERIES = [
  'Technocore FLOP',
  "technocore.chat",
  "Technocore AI agents",
  "FLOP Labs Technocore",
  "Technocore inference",
];

/** Domains this project's own agent activity already lives on -- excluded by
 * default (INCLUDE_OFFICIAL_SOURCES=false) so the room stays external mentions,
 * not our own footprint. Data, not logic: filtering just consumes a domain set. */
export const DEFAULT_OFFICIAL_DOMAINS = ["technocore.chat", "flop.finance", "github.com"];

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value.trim().toLowerCase() === "true";
}

function parseInt10(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return n;
}

function parseList(value: string | undefined, separator: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MentionsConfig {
  const searchProvider = (env.SEARCH_PROVIDER?.trim().toLowerCase() || "tavily") as SearchProviderName;
  if (searchProvider !== "tavily" && searchProvider !== "searxng") {
    throw new ConfigError(`SEARCH_PROVIDER must be "tavily" or "searxng", got ${JSON.stringify(env.SEARCH_PROVIDER)}`);
  }

  const tavilySearchDepth = (env.TAVILY_SEARCH_DEPTH?.trim().toLowerCase() || "basic") as "basic" | "advanced";
  if (tavilySearchDepth !== "basic" && tavilySearchDepth !== "advanced") {
    throw new ConfigError(`TAVILY_SEARCH_DEPTH must be "basic" or "advanced", got ${JSON.stringify(env.TAVILY_SEARCH_DEPTH)}`);
  }

  const searchQueries = parseList(env.SEARCH_QUERIES, "|");
  const queries = searchQueries.length > 0 ? searchQueries : DEFAULT_QUERIES;

  const queriesPerRun = parseInt10(env.QUERIES_PER_RUN, 2, "QUERIES_PER_RUN");
  if (queriesPerRun < 1) throw new ConfigError("QUERIES_PER_RUN must be at least 1");

  const useOpenAi = parseBool(env.USE_OPENAI, false);
  const filterWithOpenAi = parseBool(env.FILTER_WITH_OPENAI, false);
  const generateSummary = parseBool(env.GENERATE_SUMMARY, false);

  if (useOpenAi && (filterWithOpenAi || generateSummary)) {
    if (!env.OPENAI_API_KEY) throw new ConfigError("OPENAI_API_KEY is required when USE_OPENAI=true and FILTER_WITH_OPENAI or GENERATE_SUMMARY is true");
    if (!env.OPENAI_MODEL) throw new ConfigError("OPENAI_MODEL is required when USE_OPENAI=true and FILTER_WITH_OPENAI or GENERATE_SUMMARY is true");
  }

  return {
    searchProvider,
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    tavilySearchDepth,
    tavilyMaxResults: parseInt10(env.TAVILY_MAX_RESULTS, 10, "TAVILY_MAX_RESULTS"),

    searxngUrl: env.SEARXNG_URL?.trim() || "http://localhost:8888",

    searchQueries: queries,
    queriesPerRun,

    useOpenAi,
    openAiApiKey: env.OPENAI_API_KEY || undefined,
    openAiModel: env.OPENAI_MODEL || undefined,
    filterWithOpenAi,
    generateSummary,
    maxContentChars: parseInt10(env.MAX_CONTENT_CHARS, 12000, "MAX_CONTENT_CHARS"),

    technocoreRoom: env.TECHNOCORE_ROOM?.trim() || "d-technocore-links",

    maxPostsPerRun: parseInt10(env.MAX_POSTS_PER_RUN, 5, "MAX_POSTS_PER_RUN"),
    includeOfficialSources: parseBool(env.INCLUDE_OFFICIAL_SOURCES, false),
    excludedDomains: parseList(env.EXCLUDED_DOMAINS, ",").map((d) => d.toLowerCase()),

    httpTimeoutMs: parseInt10(env.HTTP_TIMEOUT_MS, 15000, "HTTP_TIMEOUT_MS"),
    maxRetries: parseInt10(env.MAX_RETRIES, 2, "MAX_RETRIES"),

    publishIfAnalysisFails: parseBool(env.PUBLISH_IF_ANALYSIS_FAILS, true),

    dbPath: env.MENTIONS_DB_PATH?.trim() || ".data/mentions.sqlite3",
    lockPath: env.MENTIONS_LOCK_PATH?.trim() || ".data/mentions.lock",
  };
}

/** Whether OpenAI needs to be called at all -- skips fetch+API cost entirely
 * when neither filtering nor summarizing is requested. */
export function shouldUseOpenAi(config: MentionsConfig): boolean {
  return config.useOpenAi && (config.filterWithOpenAi || config.generateSummary);
}

/** The full excluded-domain set: user-provided list, plus this project's own
 * domains unless the caller explicitly opted into including official sources. */
export function resolveExcludedDomains(config: MentionsConfig): Set<string> {
  const set = new Set(config.excludedDomains);
  if (!config.includeOfficialSources) {
    for (const domain of DEFAULT_OFFICIAL_DOMAINS) set.add(domain.toLowerCase());
  }
  return set;
}

export function isDomainExcluded(domain: string, excluded: Set<string>): boolean {
  const lower = domain.toLowerCase();
  for (const excludedDomain of excluded) {
    if (lower === excludedDomain || lower.endsWith(`.${excludedDomain}`)) return true;
  }
  return false;
}
