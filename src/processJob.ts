// STORY-001: process a job with idempotency and logging. Covers REQ-002
// (idempotent processing) and REQ-005 (structured logging with a correlation ID
// threaded through every step) for the walking skeleton — no real queue or
// external API call yet (STORY-002/STORY-003), so "processing" here is the
// idempotency check and its log trail, which is exactly what this story's
// acceptance criteria ask for.

import { logJson } from "./logger.js";
import type { IdempotencyStore } from "./idempotencyStore.js";
import type { MetricsCollector } from "./metrics.js";
import { isLowConfidence } from "./confidence.js";

export interface Job {
  id: string;
  correlationId: string;
  idempotencyKey: string;
  payload: unknown;
  // Optional: set for classification jobs. Below LOW_CONFIDENCE_THRESHOLD
  // (confidence.ts) the job is logged (REQ-011, STORY-002) and routed to the
  // review queue instead of being resolved (REQ-010, STORY-007).
  confidence?: number;
}

export type ProcessResult =
  | { status: "processed" }
  | { status: "needs_review" }
  | { status: "skipped_duplicate" }
  | { status: "failed"; errorClass: string };

// metrics is optional (STORY-005) and backward compatible — omitting it
// keeps STORY-001/002/003's exact original behavior, no metrics recorded.
export function processJob(job: Job, store: IdempotencyStore, metrics?: MetricsCollector): ProcessResult {
  const startedAt = Date.now();

  logJson("info", {
    event: "job_received",
    correlationId: job.correlationId,
    context: { jobId: job.id },
  });

  // STORY-007 (REQ-010): a low-confidence job is never auto-resolved, even
  // if a caller hands it here directly instead of routing it through
  // jobRouter.ts. Returned before claiming the idempotency key, so the job
  // can still be resolved for real once a human has reviewed it.
  if (isLowConfidence(job)) {
    logJson("warn", {
      event: "job_not_auto_resolved",
      correlationId: job.correlationId,
      outcome: "skipped",
      context: { jobId: job.id, confidence: job.confidence, reason: "low_confidence_needs_review" },
    });
    return { status: "needs_review" };
  }

  let claimed: boolean;
  try {
    claimed = store.claim(job.idempotencyKey);
  } catch (error) {
    const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
    logJson("error", {
      event: "job_failed",
      correlationId: job.correlationId,
      outcome: "failure",
      errorClass,
      context: { jobId: job.id },
    });
    metrics?.record("failure", Date.now() - startedAt, job.correlationId);
    return { status: "failed", errorClass };
  }

  if (!claimed) {
    logJson("info", {
      event: "job_skipped_duplicate",
      correlationId: job.correlationId,
      outcome: "skipped",
      context: { jobId: job.id, idempotencyKey: job.idempotencyKey },
    });
    // Deliberately not recorded in SLO metrics: a correctly-skipped
    // duplicate is neither a new success nor a failure of processing — it's
    // the idempotency guard doing its job. Counting it either way would
    // distort the success rate against what actually happened.
    return { status: "skipped_duplicate" };
  }

  logJson("info", {
    event: "job_processed",
    correlationId: job.correlationId,
    outcome: "success",
    context: { jobId: job.id },
  });
  metrics?.record("success", Date.now() - startedAt, job.correlationId);
  return { status: "processed" };
}
