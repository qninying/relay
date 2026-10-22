// STORY-006: the standing consumer loop STORY-002 deliberately left out. One
// loop = one worker: dequeue, process, repeat, until told to stop. Stopping
// is graceful: the signal is only checked between jobs, so a job that has
// been dequeued is always finished before the loop returns.
//
// Failure handling: a dequeue error (Redis blip) is logged and the loop backs
// off and keeps going, rather than killing the worker over one transient
// error. Capped by maxConsecutiveErrors so a worker facing a permanently dead
// Redis exits (and gets logged and replaced by the pool) instead of spinning
// forever.
//
// STORY-009: a job is acked only after it has been handled, never on
// delivery. A worker killed mid-job leaves its message pending, and another
// worker reclaims it after reclaimIdleMs. A message that has been delivered
// more than maxDeliveries times goes to the DLQ instead of crashing workers
// forever. The durable (Redis) idempotency store stops a reclaimed job that
// had in fact been processed from being processed again.

import { logJson } from "./logger.js";
import { routeJob } from "./jobRouter.js";
import type { BatchWorkerDeps } from "./batchWorker.js";
import type { DurableIdempotencyStore, IdempotencyStore } from "./idempotencyStore.js";
import type { Delivery, RedisStreamQueue } from "./queue.js";
import { moveToDeadLetterQueue } from "./dlq.js";

export interface WorkerLoopOptions {
  workerId: string;
  // Correlation ID of the scaling decision that started this worker, so a
  // worker's whole lifetime traces back to the autoscale event that caused it.
  correlationId: string;
  signal: AbortSignal;
  // STORY-007: where low-confidence jobs go instead of being processed, and
  // the DLQ fallback if the review queue can't be written to.
  reviewQueue?: RedisStreamQueue;
  dlq?: RedisStreamQueue;
  // STORY-009: shared idempotency store (Redis) so a job redelivered to a
  // different worker isn't processed twice. Worker processes always set it.
  durableStore?: DurableIdempotencyStore;
  // A message left unacked this long by another consumer is taken over.
  // Must exceed the longest real job. Default 30s.
  reclaimIdleMs?: number;
  reclaimEvery?: number;
  // Deliveries after which a message is dead-lettered. Default 5.
  maxDeliveries?: number;
  simulatedWorkMs?: number;
  // STORY-103: classify batch items and record their results.
  batch?: BatchWorkerDeps;
  idlePollMs?: number;
  errorBackoffMs?: number;
  maxConsecutiveErrors?: number;
}

export interface WorkerLoopResult {
  processed: number;
  stoppedBecause: "signal" | "too_many_errors";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export async function runWorkerLoop(
  queue: RedisStreamQueue,
  store: IdempotencyStore,
  options: WorkerLoopOptions
): Promise<WorkerLoopResult> {
  const { workerId, correlationId, signal } = options;
  const idlePollMs = options.idlePollMs ?? 200;
  const errorBackoffMs = options.errorBackoffMs ?? 500;
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5;
  const reclaimIdleMs = options.reclaimIdleMs ?? 30_000;
  const reclaimEvery = options.reclaimEvery ?? 20;
  const maxDeliveries = options.maxDeliveries ?? 5;

  let processed = 0;
  let consecutiveErrors = 0;
  let iteration = 0;

  while (!signal.aborted) {
    iteration += 1;
    let delivery: Delivery | null = null;
    try {
      // Stale work left by a dead worker is checked periodically even under
      // load, and whenever there's nothing new, so it never starves behind a
      // long backlog.
      if (iteration % reclaimEvery === 0) delivery = (await queue.reclaimStale(workerId, reclaimIdleMs, 1))[0] ?? null;
      if (!delivery) delivery = await queue.readNew(workerId);
      if (!delivery) delivery = (await queue.reclaimStale(workerId, reclaimIdleMs, 1))[0] ?? null;
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      logJson("error", {
        event: "worker_dequeue_failed",
        correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { workerId, consecutiveErrors, maxConsecutiveErrors },
      });
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { processed, stoppedBecause: "too_many_errors" };
      }
      await sleep(errorBackoffMs, signal);
      continue;
    }

    if (!delivery) {
      await sleep(idlePollMs, signal);
      continue;
    }

    if (await deadLetterIfPoisoned(queue, delivery, workerId, maxDeliveries, options.dlq)) continue;

    const { job } = delivery;
    // Drill/demo only: widens the window between taking a job and finishing
    // it, so a chaos drill's SIGKILL lands mid-job. Deliberately not
    // abortable: a graceful stop still finishes the job it holds.
    if (options.simulatedWorkMs) await new Promise((resolve) => setTimeout(resolve, options.simulatedWorkMs));

    try {
      await routeJob(job, {
        store,
        durableStore: options.durableStore,
        reviewQueue: options.reviewQueue,
        reviewOptions: { dlq: options.dlq },
        batch: options.batch,
      });
    } catch (error) {
      // routeToReviewQueue already logged review_route_failed with the job's
      // correlation ID. Not acked: the job stays pending and is reclaimed and
      // retried, and maxDeliveries dead-letters it if it never succeeds.
      logJson("error", {
        event: "worker_job_unplaced",
        correlationId: job.correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { workerId, jobId: job.id },
      });
      continue;
    }

    await ackOrLog(queue, delivery, workerId);
    processed += 1;
  }

  return { processed, stoppedBecause: "signal" };
}

// A message delivered more than maxDeliveries times has crashed or failed
// that many workers; retrying it again just repeats that. It goes to the DLQ
// with its own reason (and is acked off the work stream). Returns true when
// it was handled here.
async function deadLetterIfPoisoned(
  queue: RedisStreamQueue,
  delivery: Delivery,
  workerId: string,
  maxDeliveries: number,
  dlq: RedisStreamQueue | undefined
): Promise<boolean> {
  if (delivery.deliveryCount <= maxDeliveries) return false;
  const { job } = delivery;
  if (!dlq) {
    // Nowhere safe to put it: leave it pending (never drop it) and say so.
    logJson("error", {
      event: "job_poison_unplaced",
      correlationId: job.correlationId,
      outcome: "failure",
      context: { workerId, jobId: job.id, deliveryCount: delivery.deliveryCount, maxDeliveries },
    });
    return true;
  }
  try {
    await moveToDeadLetterQueue(dlq, job, `max_deliveries_exceeded: delivered ${delivery.deliveryCount} times`);
  } catch (error) {
    // Not acked, so still pending on the work stream: nothing lost.
    logJson("error", {
      event: "job_poison_dlq_failed",
      correlationId: job.correlationId,
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { workerId, jobId: job.id, deliveryCount: delivery.deliveryCount },
    });
    return true;
  }
  await ackOrLog(queue, delivery, workerId);
  return true;
}

// An ack that fails leaves the message pending; it will be reclaimed and the
// durable idempotency claim will skip it as a duplicate. Safe, just logged.
async function ackOrLog(queue: RedisStreamQueue, delivery: Delivery, workerId: string): Promise<void> {
  try {
    await queue.ack(delivery.messageId);
  } catch (error) {
    logJson("warn", {
      event: "job_ack_failed",
      correlationId: delivery.job.correlationId,
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { workerId, jobId: delivery.job.id, messageId: delivery.messageId },
    });
  }
}
