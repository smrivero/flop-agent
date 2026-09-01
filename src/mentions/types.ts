export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  /** ISO-ish date string if the provider gives one; not guaranteed. */
  publishedDate?: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

/** A search result after canonicalization, before we know if it's new. Carries
 * enough of "how was this found" for reproducibility (search_query/search_provider
 * land in SQLite unchanged, so a later run -- or a human -- can see exactly what
 * turned this URL up). */
export interface Candidate {
  canonicalUrl: string;
  urlHash: string;
  originalUrl: string;
  title: string;
  domain: string;
  snippet: string;
  publishedDate?: string;
  searchQuery: string;
  searchProvider: string;
}

export type MentionStatus = "discovered" | "rejected" | "published" | "publish_failed" | "analysis_failed";

export interface MentionRow {
  id: number;
  finding_id: string | null;
  canonical_url: string;
  url_hash: string;
  original_url: string | null;
  title: string | null;
  domain: string | null;
  snippet: string | null;
  published_date: string | null;
  /** The finding text itself -- what the source specifically says about
   * Technocore (was named `summary`; renamed in place, same column, no data
   * lost, since it already served exactly this role). */
  finding: string | null;
  content_hash: string | null;
  search_query: string | null;
  search_provider: string | null;
  discovered_at: string;
  checked_at: string | null;
  published_at: string | null;
  updated_at: string | null;
  technocore_room: string | null;
  technocore_message_id: string | null;
  status: MentionStatus;
  error: string | null;
}

export interface AnalysisResult {
  related: boolean;
  finding: string;
}

export interface RunSummary {
  queries: number;
  results: number;
  duplicates: number;
  new: number;
  rejected: number;
  published: number;
}
