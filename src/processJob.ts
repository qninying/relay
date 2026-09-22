// STORY-001: process a job with idempotency and logging. Covers REQ-002
// (idempotent processing) and REQ-005 (structured logging with a correlation ID
// threaded through every step) for the walking skeleton — no real queue or
// external API call yet (STORY-002/STORY-003), so "processing" here is the
// idempotency check and its log trail, which is exactly what this story's
// acceptance criteria ask for.

import { logJson } from "./logger.js";
import type { IdempotencyStore } from "./idempotencyStore.js";

export interface Job {
  id: string;
  correlationId: string;
  idempotencyKey: string;
  payload: unknown;
}

export type ProcessResult =
  | { status: "processed" }
  | { status: "skipped_duplicate" }
  | { status: "failed"; errorClass: string };

export function processJob(job: Job, store: IdempotencyStore): ProcessResult {
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
    return { status: "failed", errorClass };
  }

  if (!claimed) {
    logJson("info", {
      event: "job_skipped_duplicate",
      correlationId: job.correlationId,
      outcome: "skipped",
      context: { jobId: job.id, idempotencyKey: job.idempotencyKey },
    });
    return { status: "skipped_duplicate" };
  }

  logJson("info", {
    event: "job_processed",
    correlationId: job.correlationId,
    outcome: "success",
    context: { jobId: job.id },
  });
  return { status: "processed" };
}
