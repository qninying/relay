// STORY-012 (REQ-016): summaries grounded strictly in the source data pulled
// for each item. The order is the guarantee:
// 1. Fetch the item's source. No source, no summary: the summarizer is never
//    called on nothing, so it can't fill the gap from its own knowledge.
// 2. Archive the exact source text by SHA-256 (sourceArchive.ts), so the
//    summary can be re-checked against precisely what it was built from.
// 3. Summarize from that text only.
// 4. Check the summary with the grounding guardrail
//    (guardrails/groundingGuardrail.ts): enough overlap with the source, and
//    no number that isn't in the source. A summary that fails goes to the
//    review queue (STORY-007) as ungrounded_summary, never out as a result.
//
// Every outcome is logged with the job's correlation ID and the source's id,
// SHA-256 and length; the result carries the same source reference, so the
// audit trail survives a logging outage (logger.ts counts dropped lines).
//
// Failure paths: source unavailable (fetch fails/times out) or missing
// (empty) fails before summarizing; source can't be archived fails rather
// than producing an unverifiable summary; summarizer fails or hangs fails
// after capped retries.

import { logJson } from "./logger.js";
import type { Job } from "./processJob.js";
import { withReliability, type ReliabilityOptions } from "./withReliability.js";
import { sha256Of, type SourceArchive } from "./sourceArchive.js";
import { routeToReviewQueue, type ReviewRouteOptions } from "./reviewQueue.js";
import type { RedisStreamQueue } from "./queue.js";
import { checkGroundingGuardrail, type GroundingViolation } from "../guardrails/groundingGuardrail.js";

export interface SourceDocument {
  sourceId: string;
  text: string;
}

export type SourceProvider = (job: Job) => Promise<SourceDocument | null>;
export type Summarizer = (input: { sourceText: string }) => Promise<{ summary: string }>;

export interface SourceRef {
  sourceId: string;
  sha256: string;
  chars: number;
}

export type SummaryResult =
  | { status: "grounded"; summary: string; source: SourceRef; overlapRatio: number }
  | { status: "ungrounded"; violations: GroundingViolation[]; overlapRatio: number; source: SourceRef; routedTo: "review" | "dlq" | null }
  | { status: "failed"; reason: "source_unavailable" | "source_missing"; errorClass?: string }
  | { status: "failed"; reason: "source_not_archived" | "summarizer_failed"; errorClass: string; source: SourceRef };

export interface SummarizeOptions {
  reliability: Omit<ReliabilityOptions, "circuitBreaker">;
  archive: SourceArchive;
  reviewQueue?: RedisStreamQueue;
  reviewOptions?: Omit<ReviewRouteOptions, "reason" | "details">;
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

export async function summarizeJob(
  job: Job,
  summarizer: Summarizer,
  getSource: SourceProvider,
  options: SummarizeOptions
): Promise<SummaryResult> {
  const { correlationId } = job;
  const fail = <R extends SummaryResult>(result: R, context: Record<string, unknown> = {}): R => {
    logJson("error", {
      event: "summary_failed",
      correlationId,
      outcome: "failure",
      errorClass: "errorClass" in result ? result.errorClass : undefined,
      context: { jobId: job.id, reason: "reason" in result ? result.reason : undefined, ...context },
    });
    return result;
  };

  let source: SourceDocument | null;
  try {
    source = await withReliability(() => getSource(job), options.reliability);
  } catch (error) {
    return fail({ status: "failed", reason: "source_unavailable", errorClass: errorClassOf(error) });
  }
  if (!source || typeof source.text !== "string" || source.text.trim().length === 0) {
    return fail({ status: "failed", reason: "source_missing" }, { sourceId: source?.sourceId ?? null });
  }

  const sourceRef: SourceRef = { sourceId: source.sourceId, sha256: sha256Of(source.text), chars: source.text.length };
  try {
    await options.archive.put(source.sourceId, source.text);
  } catch (error) {
    return fail({ status: "failed", reason: "source_not_archived", errorClass: errorClassOf(error), source: sourceRef }, { source: sourceRef });
  }

  let summary: string;
  try {
    const output = await withReliability(() => summarizer({ sourceText: source.text }), options.reliability);
    summary = typeof output?.summary === "string" ? output.summary : "";
  } catch (error) {
    return fail({ status: "failed", reason: "summarizer_failed", errorClass: errorClassOf(error), source: sourceRef }, { source: sourceRef });
  }

  const check = checkGroundingGuardrail({ sourceText: source.text, summaryText: summary });
  if (!check.allowed) {
    logJson("warn", {
      event: "summary_rejected_ungrounded",
      correlationId,
      outcome: "failure",
      context: { jobId: job.id, violations: check.violations, overlapRatio: check.overlapRatio, source: sourceRef },
    });
    let routedTo: "review" | "dlq" | null = null;
    if (options.reviewQueue) {
      const routed = await routeToReviewQueue(options.reviewQueue, job, {
        ...options.reviewOptions,
        reason: "ungrounded_summary",
        details: { violations: check.violations, overlapRatio: check.overlapRatio, rejectedSummary: summary, source: sourceRef },
      });
      routedTo = routed.routedTo;
    }
    return { status: "ungrounded", violations: check.violations, overlapRatio: check.overlapRatio, source: sourceRef, routedTo };
  }

  logJson("info", {
    event: "summary_generated",
    correlationId,
    outcome: "success",
    context: { jobId: job.id, overlapRatio: check.overlapRatio, source: sourceRef },
  });
  return { status: "grounded", summary, source: sourceRef, overlapRatio: check.overlapRatio };
}

// Re-checks a summary against its archived source: the source must still
// exist, still hash to the recorded SHA-256, and the summary must still pass
// the grounding guardrail against it. How a reviewer or auditor confirms a
// summary was grounded without trusting the original log line.
export async function verifySummary(
  summary: string,
  sourceSha256: string,
  archive: SourceArchive
): Promise<{ verified: true; sourceId: string } | { verified: false; reason: "source_not_found" | "not_grounded" }> {
  const archived = await archive.get(sourceSha256);
  if (!archived) return { verified: false, reason: "source_not_found" };
  const check = checkGroundingGuardrail({ sourceText: archived.text, summaryText: summary });
  return check.allowed ? { verified: true, sourceId: archived.sourceId } : { verified: false, reason: "not_grounded" };
}
