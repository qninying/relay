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

import { logJson } from "./logger.js";
import { processJob } from "./processJob.js";
import type { IdempotencyStore } from "./idempotencyStore.js";
import type { RedisStreamQueue } from "./queue.js";

export interface WorkerLoopOptions {
  workerId: string;
  // Correlation ID of the scaling decision that started this worker, so a
  // worker's whole lifetime traces back to the autoscale event that caused it.
  correlationId: string;
  signal: AbortSignal;
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

  let processed = 0;
  let consecutiveErrors = 0;

  while (!signal.aborted) {
    let job;
    try {
      job = await queue.dequeueOne(workerId);
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

    if (!job) {
      await sleep(idlePollMs, signal);
      continue;
    }

    processJob(job, store);
    processed += 1;
  }

  return { processed, stoppedBecause: "signal" };
}
