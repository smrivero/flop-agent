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

/** A search result after canonicalization, before we know if it's new. */
export interface Candidate {
  canonicalUrl: string;
  urlHash: string;
  originalUrl: string;
  title: string;
  domain: string;
  snippet: string;
  publishedDate?: string;
}

export type MentionStatus = "discovered" | "rejected" | "published" | "publish_failed" | "analysis_failed";

export interface MentionRow {
  id: number;
  canonical_url: string;
  url_hash: string;
  original_url: string | null;
  title: string | null;
  domain: string | null;
  snippet: string | null;
  published_date: string | null;
  discovered_at: string;
  updated_at: string | null;
  technocore_room: string | null;
  technocore_message_id: string | null;
  summary: string | null;
  status: MentionStatus;
  error: string | null;
}

export interface AnalysisResult {
  relevant: boolean;
  summary: string;
}

export interface RunSummary {
  queries: number;
  results: number;
  duplicates: number;
  new: number;
  rejected: number;
  published: number;
}
