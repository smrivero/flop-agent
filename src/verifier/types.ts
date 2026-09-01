export type VerificationResult = "VERIFIED" | "REJECTED";

/** Distinct from mentions.MentionStatus -- this tracks the *verification's* own
 * lifecycle, not the finding's. A finding can be `published` in `mentions`
 * while its verification row here is still `pending` or being retried. */
export type VerificationStatus = "pending" | "verified" | "rejected" | "publish_failed" | "verification_failed";

export interface VerificationRow {
  id: number;
  finding_id: string;
  result: VerificationResult | null;
  reason: string | null;
  verifier_did: string | null;
  original_content_hash: string | null;
  verification_content_hash: string | null;
  verified_at: string | null;
  technocore_room: string | null;
  technocore_message_id: string | null;
  status: VerificationStatus;
  error: string | null;
  created_at: string;
  updated_at: string | null;
}

/** What the independent-verification analysis needs and returns. */
export interface VerifyAnalysisInput {
  originalFinding: string;
  sourceContent: string;
}

export interface VerifyAnalysisResult {
  result: VerificationResult;
  reason: string;
}
