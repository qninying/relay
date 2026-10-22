// STORY-007: the one decision every dequeued job goes through. A
// low-confidence job goes to the review queue and is never processed (never
// auto-resolved); everything else goes to processJob as before. Kept as its
// own module so the worker loop stays a loop and this rule lives in one
// place.

import { isLowConfidence } from "./confidence.js";
import { processJob, processJobDurable, type Job, type ProcessResult } from "./processJob.js";
import type { DurableIdempotencyStore, IdempotencyStore } from "./idempotencyStore.js";
import type { RedisStreamQueue } from "./queue.js";
import { routeToReviewQueue, type ReviewRouteOptions, type ReviewRouteResult } from "./reviewQueue.js";

export interface JobRouting {
  store: IdempotencyStore;
  // STORY-009: when set, the idempotency claim is made here (shared across
  // worker processes) instead of in the per-process store.
  durableStore?: DurableIdempotencyStore;
  reviewQueue?: RedisStreamQueue;
  reviewOptions?: ReviewRouteOptions;
}

export type RouteOutcome = { route: "review"; result: ReviewRouteResult } | { route: "process"; result: ProcessResult };

export async function routeJob(job: Job, routing: JobRouting): Promise<RouteOutcome> {
  if (isLowConfidence(job) && routing.reviewQueue) {
    return { route: "review", result: await routeToReviewQueue(routing.reviewQueue, job, routing.reviewOptions) };
  }
  // Without a review queue, processJob's own guard still refuses to resolve a
  // low-confidence job (returns needs_review and logs job_not_auto_resolved).
  const result = routing.durableStore ? await processJobDurable(job, routing.durableStore) : processJob(job, routing.store);
  return { route: "process", result };
}
