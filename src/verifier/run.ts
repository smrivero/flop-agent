/**
 * Orchestrates one Verifier pass: select pending findings from the shared
 * SQLite file, independently re-fetch each one's URL (never trust Radar's
 * stored `finding` text as source material -- only as the claim being
 * checked), ask OpenAI to compare, then publish the verdict signed with
 * Agent B and persist the result.
 *
 * Retry semantics (see database.ts):
 * - `verification_failed` (fetch or OpenAI failed) -> redo fetch + analysis
 *   from scratch next run; nothing usable was cached.
 * - `publish_failed` (analysis succeeded, the Technocore write didn't) ->
 *   skip fetch + OpenAI entirely and just retry the publish, using the
 *   result/reason/hash already stored -- never re-spend an OpenAI call for a
 *   verdict that was already reached.
 */

import { extractContent } from "../mentions/content/extractContent.js";
import { fetchArticle } from "../mentions/content/fetchArticle.js";
import { hashContent } from "../mentions/finding.js";
import type { MentionRow } from "../mentions/types.js";
import {
  ensurePendingVerification,
  getPendingFindingsToVerify,
  markAnalyzed,
  markPublishFailed,
  markPublished,
  markVerificationFailed,
  resetVerification,
  type VerifierDb,
} from "./database.js";
import { verifyAnalysis } from "./openai.js";
import { formatVerificationMessage, type SendVerificationFn } from "./publisher.js";
import type { VerificationResult } from "./types.js";
import type { VerifierConfig } from "./config.js";
import type { VerifierIdentities } from "./identity.js";

export interface RunVerifierOptions {
  config: VerifierConfig;
  db: VerifierDb;
  identities: VerifierIdentities;
  send: SendVerificationFn;
  dryRun: boolean;
  /** Verify only this finding_id, ignoring VERIFIER_MAX_PER_RUN / sample rate. */
  onlyFindingId?: string;
  /** Re-verify even a finding whose verification is already finalized (verified/rejected). Testing only. */
  force: boolean;
  maxContentChars: number;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Injectable for tests -- default to the real implementations. Mirrors
   * mentions/run.ts's RunDeps pattern so tests never need to stub global fetch. */
  fetchArticleFn?: typeof fetchArticle;
  analyzeFn?: typeof verifyAnalysis;
}

export interface VerifierRunSummary {
  candidates: number;
  verified: number;
  rejected: number;
  verificationFailed: number;
  publishFailed: number;
  skippedDryRun: number;
}

function pickSample(findings: MentionRow[], sampleRate: number): MentionRow[] {
  if (sampleRate >= 1) return findings;
  return findings.filter(() => Math.random() < sampleRate);
}

export async function runVerifier(options: RunVerifierOptions): Promise<VerifierRunSummary> {
  const { config, db, identities, send, log } = options;
  const fetchArticleFn = options.fetchArticleFn ?? fetchArticle;
  const analyzeFn = options.analyzeFn ?? verifyAnalysis;
  const summary: VerifierRunSummary = { candidates: 0, verified: 0, rejected: 0, verificationFailed: 0, publishFailed: 0, skippedDryRun: 0 };

  let findings: MentionRow[];
  if (options.onlyFindingId) {
    const row = db.prepare(`SELECT * FROM mentions WHERE finding_id = ?`).get(options.onlyFindingId) as MentionRow | undefined;
    if (!row) throw new Error(`No mention found with finding_id ${JSON.stringify(options.onlyFindingId)}`);
    if (row.status !== "published") throw new Error(`Finding ${options.onlyFindingId} has status ${JSON.stringify(row.status)}, not "published" -- nothing to verify`);
    findings = [row];
    if (options.force) resetVerification(db, row.finding_id!);
  } else {
    findings = pickSample(getPendingFindingsToVerify(db, config.verifierMaxPerRun), config.verifierSampleRate);
  }

  summary.candidates = findings.length;

  for (const finding of findings) {
    const findingId = finding.finding_id!;
    log("select", { finding: findingId, url: finding.canonical_url });

    const verification = ensurePendingVerification(db, findingId);

    if (verification.status === "publish_failed" && verification.result) {
      log("retry-publish", { finding: findingId, result: verification.result });
      await publishVerdict(finding, verification.result, verification.reason ?? "", options, summary);
      continue;
    }

    try {
      const html = await fetchArticleFn(finding.canonical_url, { timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries });
      if (!html) {
        markVerificationFailed(db, findingId, "independent fetch failed (no content / non-HTML / request error)");
        summary.verificationFailed++;
        log("verification_failed", { finding: findingId, reason: "fetch_failed" });
        continue;
      }
      const sourceContent = extractContent(html, options.maxContentChars);
      const verificationContentHash = hashContent(sourceContent);

      const analysis = await analyzeFn(
        { originalFinding: finding.finding ?? "", sourceContent },
        { apiKey: config.openAiApiKey!, model: config.verifierModel!, timeoutMs: config.httpTimeoutMs, maxRetries: config.maxRetries },
      );

      // Content-hash comparison is informational only (logged for audit), it
      // never overrides the LLM's judgment on the freshly-fetched content.
      log("analysis", {
        finding: findingId,
        result: analysis.result,
        original_content_hash: finding.content_hash,
        verification_content_hash: verificationContentHash,
        hash_match: finding.content_hash === verificationContentHash,
      });

      markAnalyzed(db, findingId, analysis.result, analysis.reason, identities.verifier.did, finding.content_hash, verificationContentHash);

      await publishVerdict(finding, analysis.result, analysis.reason, options, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markVerificationFailed(db, findingId, message);
      summary.verificationFailed++;
      log("verification_failed", { finding: findingId, error: message });
    }
  }

  return summary;
}

async function publishVerdict(
  finding: MentionRow,
  result: VerificationResult,
  reason: string,
  options: RunVerifierOptions,
  summary: VerifierRunSummary,
): Promise<void> {
  const { db, send, dryRun, log } = options;
  const findingId = finding.finding_id!;
  const room = finding.technocore_room ?? undefined;
  if (!room) {
    markPublishFailed(db, findingId, "original finding has no technocore_room -- cannot know where to post the verdict");
    summary.publishFailed++;
    log("publish_failed", { finding: findingId, error: "missing_room" });
    return;
  }

  const text = formatVerificationMessage(
    { findingId, canonicalUrl: finding.canonical_url, originalFinding: finding.finding ?? "(no finding text recorded)" },
    result,
    reason,
  );

  if (dryRun) {
    summary.skippedDryRun++;
    if (result === "VERIFIED") summary.verified++;
    else summary.rejected++;
    log("dry-run-publish", { finding: findingId, room, result, text });
    return;
  }

  try {
    const posted = await send(room, text);
    markPublished(db, findingId, result, room, String(posted.seq));
    if (result === "VERIFIED") summary.verified++;
    else summary.rejected++;
    log("publish", { finding: findingId, room, result, message_id: posted.seq });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markPublishFailed(db, findingId, message);
    summary.publishFailed++;
    log("publish_failed", { finding: findingId, error: message });
  }
}
