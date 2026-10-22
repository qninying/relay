// STORY-006: entry point for one real worker OS process, forked by
// ProcessWorkerPool. Everything it needs comes from env, set by the pool:
// which stream/group to consume, its worker id, and the correlation ID of
// the autoscale event that started it (so its start, every job's dequeue
// and its stop all trace back to that one scaling decision).
//
// SIGTERM is a graceful stop: the loop finishes the job it's holding, then
// exits 0. Exiting 1 means the worker gave up (Redis unreachable for
// maxConsecutiveErrors in a row); the pool logs that as an unexpected exit
// and the autoscaler's next evaluation replaces it.

import { Redis } from "ioredis";
import { logJson } from "./logger.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";
import { RedisStreamQueue } from "./queue.js";
import { runWorkerLoop } from "./workerLoop.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`workerProcess: missing required env ${name}`);
  return value;
}

async function main(): Promise<number> {
  const workerId = requireEnv("RELAY_WORKER_ID");
  const correlationId = requireEnv("RELAY_CORRELATION_ID");
  const streamKey = requireEnv("RELAY_STREAM_KEY");
  const groupName = requireEnv("RELAY_GROUP");

  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 2,
  });
  // Without a listener ioredis prints its own unstructured console.error on
  // every reconnect attempt. Failures still surface: the loop's dequeue call
  // rejects and logs worker_dequeue_failed with the correlation ID.
  redis.on("error", () => {});

  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());

  logJson("info", { event: "worker_started", correlationId, context: { workerId, pid: process.pid } });

  // Per-process store: correct today because a consumer group delivers each
  // entry to exactly one consumer. Cross-process duplicate protection on
  // redelivery needs a shared (Redis-backed) store; that's STORY-008's retry
  // work, named as a limitation rather than built here.
  const queue = new RedisStreamQueue(redis, streamKey, groupName);
  // STORY-007: review and DLQ streams default to siblings of the main stream.
  // Group names only matter to whoever consumes them (a reviewer, DLQ
  // triage); workers only write to these.
  const reviewQueue = new RedisStreamQueue(redis, process.env.RELAY_REVIEW_STREAM_KEY ?? `${streamKey}:review`, "relay-review");
  const dlq = new RedisStreamQueue(redis, process.env.RELAY_DLQ_STREAM_KEY ?? `${streamKey}:dlq`, "relay-dlq");
  const result = await runWorkerLoop(queue, new InMemoryIdempotencyStore(), {
    workerId,
    correlationId,
    signal: controller.signal,
    reviewQueue,
    dlq,
  });

  logJson(result.stoppedBecause === "signal" ? "info" : "error", {
    event: "worker_stopped",
    correlationId,
    outcome: result.stoppedBecause === "signal" ? "success" : "failure",
    context: { workerId, processed: result.processed, stoppedBecause: result.stoppedBecause },
  });

  redis.disconnect();
  return result.stoppedBecause === "signal" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    logJson("error", {
      event: "worker_crashed",
      correlationId: process.env.RELAY_CORRELATION_ID ?? "unknown",
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { message: error instanceof Error ? error.message : String(error) },
    });
    process.exit(1);
  }
);
