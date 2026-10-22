// STORY-007: the review queue for low-confidence jobs (REQ-010). Like the
// DLQ (STORY-004) it reuses RedisStreamQueue pointed at its own stream, but
// it means something different: a DLQ entry is a job that failed, a review
// entry is a job that worked but whose answer isn't trustworthy enough to
// accept without a human. Keeping them apart is the whole point of REQ-010.
//
// Failure path: the job has already been acked off the main stream by the
// time it gets here, so a review queue that can't be written to must not
// mean a lost job. Writes retry with capped backoff; if every attempt fails
// the job falls back to the DLQ with reason "review_queue_unavailable"
// (visible and triageable, still not resolved), and with no DLQ configured
// the error is thrown so the caller knows the job was not placed anywhere.

import type { RedisStreamQueue } from "./queue.js";
import { logJson } from "./logger.js";
import type { Job } from "./processJob.js";
import { LOW_CONFIDENCE_THRESHOLD } from "./confidence.js";
import { moveToDeadLetterQueue } from "./dlq.js";

export const REVIEW_FALLBACK_REASON = "review_queue_unavailable";

export class ReviewRouteFailedError extends Error {}

export interface ReviewRouteOptions {
  dlq?: RedisStreamQueue;
  maxAttempts?: number;
  backoffMs?: number;
}

export type ReviewRouteResult = { routedTo: "review"; attempts: number } | { routedTo: "dlq"; attempts: number };

// The original job is preserved whole (same as a DLQ entry), plus why it
// needs review, so a reviewer sees exactly what the worker saw.
function buildReviewEntry(job: Job): Job {
  return {
    id: job.id,
    correlationId: job.correlationId,
    idempotencyKey: job.idempotencyKey,
    confidence: job.confidence,
    payload: {
      originalPayload: job.payload,
      reason: "low_confidence",
      confidence: job.confidence,
      threshold: LOW_CONFIDENCE_THRESHOLD,
      routedAt: new Date().toISOString(),
    },
  };
}

export async function routeToReviewQueue(
  reviewQueue: RedisStreamQueue,
  job: Job,
  options: ReviewRouteOptions = {}
): Promise<ReviewRouteResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 200;
  const entry = buildReviewEntry(job);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { messageId } = await reviewQueue.enqueue(entry);
      logJson("info", {
        event: "job_routed_to_review",
        correlationId: job.correlationId,
        outcome: "success",
        context: { jobId: job.id, confidence: job.confidence, threshold: LOW_CONFIDENCE_THRESHOLD, messageId, attempt },
      });
      return { routedTo: "review", attempts: attempt };
    } catch (error) {
      logJson("warn", {
        event: "review_route_attempt_failed",
        correlationId: job.correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { jobId: job.id, attempt, maxAttempts },
      });
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
      }
    }
  }

  if (!options.dlq) {
    logJson("error", {
      event: "review_route_failed",
      correlationId: job.correlationId,
      outcome: "failure",
      context: { jobId: job.id, attempts: maxAttempts, fallback: "none" },
    });
    throw new ReviewRouteFailedError(`Could not route job ${job.id} to the review queue after ${maxAttempts} attempts`);
  }

  logJson("error", {
    event: "review_route_failed",
    correlationId: job.correlationId,
    outcome: "failure",
    context: { jobId: job.id, attempts: maxAttempts, fallback: "dlq" },
  });
  await moveToDeadLetterQueue(options.dlq, job, REVIEW_FALLBACK_REASON);
  return { routedTo: "dlq", attempts: maxAttempts };
}
