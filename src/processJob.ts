// STORY-001: process a job with idempotency and logging. Covers REQ-002
// (idempotent processing) and REQ-005 (structured logging with a correlation ID
// threaded through every step) for the walking skeleton — no real queue or
// external API call yet (STORY-002/STORY-003), so "processing" here is the
// idempotency check and its log trail, which is exactly what this story's
// acceptance criteria ask for.

import { logJson } from "./logger.js";
import type { IdempotencyStore } from "./idempotencyStore.js";
import type { MetricsCollector } from "./metrics.js";

export interface Job {
  id: string;
  correlationId: string;
  idempotencyKey: string;
  payload: unknown;
  // Optional: set for classification jobs. STORY-002 logs low-confidence jobs
  // (REQ-011) when this crosses LOW_CONFIDENCE_THRESHOLD in queue.ts; routing
  // a low-confidence job to a review queue instead of the DLQ is REQ-010,
  // STORY-007's job, not this one.
  confidence?: number;
}

export type ProcessResult =
  | { status: "processed" }
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
