// STORY-007 against REAL Redis: low-confidence jobs land in the review
// stream (not the DLQ, not processed), every step logged with the job's
// correlation ID. Skips cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { routeToReviewQueue, ReviewRouteFailedError, REVIEW_FALLBACK_REASON } from "./reviewQueue.js";
import { routeJob } from "./jobRouter.js";
import { runWorkerLoop } from "./workerLoop.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";
import { processJob, type Job } from "./processJob.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) {
  console.warn("[reviewQueue.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");
}

function job(overrides: Partial<Job> = {}): Job {
  return { id: "job-1", correlationId: "corr-1", idempotencyKey: "idem-1", payload: { text: "Acme Corp" }, ...overrides };
}

function lines(...spies: Array<ReturnType<typeof vi.spyOn>>): Array<Record<string, unknown>> {
  return spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string)));
}

// An enqueue that always fails, to stand in for a review stream Redis rejects.
function brokenQueue(): RedisStreamQueue {
  return { enqueue: vi.fn().mockRejectedValue(new Error("READONLY You can't write against a read only replica")) } as unknown as RedisStreamQueue;
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!redisAvailable)("review queue routing (integration, real Redis)", () => {
  const suffix = Math.random().toString(36).slice(2);
  const main = new RedisStreamQueue(redis, `relay:test:review-main:${suffix}`, "g-main");
  const review = new RedisStreamQueue(redis, `relay:test:review:${suffix}`, "g-review");
  const dlq = new RedisStreamQueue(redis, `relay:test:review-dlq:${suffix}`, "g-dlq");

  beforeAll(async () => {
    await main.ensureConsumerGroup();
    await review.ensureConsumerGroup();
    await dlq.ensureConsumerGroup();
  });

  afterAll(async () => {
    await redis.del(`relay:test:review-main:${suffix}`, `relay:test:review:${suffix}`, `relay:test:review-dlq:${suffix}`);
  });

  it("criterion 1 + 2: a low-confidence job is processed into the review queue, not resolved, logged with its correlation ID", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const before = (await review.peek(100)).length;

    const outcome = await routeJob(job({ id: "low-1", correlationId: "corr-low-1", idempotencyKey: "idem-low-1", confidence: 0.2 }), {
      store,
      reviewQueue: review,
      reviewOptions: { dlq },
    });

    expect(outcome).toEqual({ route: "review", result: { routedTo: "review", attempts: 1 } });
    const entries = await review.peek(100);
    expect(entries).toHaveLength(before + 1);
    const entry = entries.at(-1)!;
    expect(entry).toMatchObject({ id: "low-1", correlationId: "corr-low-1", confidence: 0.2 });
    expect(entry.payload).toMatchObject({ originalPayload: { text: "Acme Corp" }, reason: "low_confidence", confidence: 0.2, threshold: 0.5 });

    const routed = lines(log).find((l) => l.event === "job_routed_to_review");
    expect(routed).toMatchObject({ correlationId: "corr-low-1", outcome: "success", context: { jobId: "low-1", confidence: 0.2 } });
    expect(lines(log).some((l) => l.event === "job_processed")).toBe(false);
    // Not auto-resolved: the idempotency key was never claimed.
    expect(store.claim("idem-low-1")).toBe(true);
    // Not dead-lettered either.
    expect(await dlq.getBacklog()).toBe(0);
  });

  it("a normal-confidence job is still processed as before, and does not touch the review queue", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = (await review.peek(100)).length;
    const outcome = await routeJob(job({ id: "ok-1", correlationId: "corr-ok-1", idempotencyKey: "idem-ok-1", confidence: 0.9 }), {
      store: new InMemoryIdempotencyStore(),
      reviewQueue: review,
    });
    expect(outcome).toEqual({ route: "process", result: { status: "processed" } });
    expect(await review.peek(100)).toHaveLength(before);
    expect(lines(log).find((l) => l.event === "job_processed")).toMatchObject({ correlationId: "corr-ok-1" });
  });

  it("the boundary: exactly the threshold is not low confidence; just under it is", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    expect((await routeJob(job({ id: "b1", idempotencyKey: "b1", confidence: 0.5 }), { store, reviewQueue: review })).route).toBe("process");
    expect((await routeJob(job({ id: "b2", idempotencyKey: "b2", confidence: 0.4999 }), { store, reviewQueue: review })).route).toBe("review");
  });

  it("end to end through the real worker loop: low-confidence to review, normal processed, nothing to the DLQ", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = (await review.peek(100)).length;
    await main.enqueue(job({ id: "w-low", correlationId: "corr-w-low", idempotencyKey: "w-low", confidence: 0.1 }));
    await main.enqueue(job({ id: "w-ok", correlationId: "corr-w-ok", idempotencyKey: "w-ok", confidence: 0.95 }));

    const controller = new AbortController();
    const loop = runWorkerLoop(main, new InMemoryIdempotencyStore(), {
      workerId: "w-test",
      correlationId: "scale-test",
      signal: controller.signal,
      reviewQueue: review,
      dlq,
      idlePollMs: 20,
    });
    const deadline = Date.now() + 5000;
    while ((await main.getBacklog()) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    expect(await loop).toMatchObject({ processed: 2 });

    const reviewIds = (await review.peek(100)).slice(before).map((j) => j.id);
    expect(reviewIds).toEqual(["w-low"]);
    const events = lines(log);
    // Trust: the low-confidence job's own trail, same correlation ID throughout.
    const lowTrail = events.filter((l) => l.correlationId === "corr-w-low").map((l) => l.event);
    expect(lowTrail).toEqual(["job_low_confidence", "job_dequeued", "job_routed_to_review"]);
    expect(events.find((l) => l.event === "job_processed")).toMatchObject({ correlationId: "corr-w-ok" });
    expect(await dlq.getBacklog()).toBe(0);
  });

  it("failure path: the review queue is unwritable, so it retries, then falls back to the DLQ rather than losing or resolving the job", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = brokenQueue();

    const result = await routeToReviewQueue(broken, job({ id: "f-1", correlationId: "corr-f-1", confidence: 0.3 }), {
      dlq,
      maxAttempts: 3,
      backoffMs: 1,
    });

    expect(result).toEqual({ routedTo: "dlq", attempts: 3 });
    expect(broken.enqueue).toHaveBeenCalledTimes(3);
    const events = lines(warn, error);
    expect(events.filter((l) => l.event === "review_route_attempt_failed")).toHaveLength(3);
    expect(events.find((l) => l.event === "review_route_failed")).toMatchObject({ correlationId: "corr-f-1", context: { fallback: "dlq" } });
    expect(events.find((l) => l.event === "job_moved_to_dlq")).toMatchObject({ correlationId: "corr-f-1", context: { failureReason: REVIEW_FALLBACK_REASON } });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const dead = await dlq.dequeueOne("dlq-reader");
    expect(dead).toMatchObject({ id: "f-1", payload: { failureReason: REVIEW_FALLBACK_REASON } });
  });

  it("failure path: with no DLQ configured, a failed route throws (and is logged) instead of pretending it succeeded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(routeToReviewQueue(brokenQueue(), job({ correlationId: "corr-f-2", confidence: 0.3 }), { maxAttempts: 2, backoffMs: 1 })).rejects.toBeInstanceOf(
      ReviewRouteFailedError
    );
    expect(lines(error).find((l) => l.event === "review_route_failed")).toMatchObject({ correlationId: "corr-f-2", context: { fallback: "none" } });
  });

  it("failure path: the worker loop survives an unplaceable job, logs it, and keeps going", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await main.enqueue(job({ id: "u-1", correlationId: "corr-u-1", idempotencyKey: "u-1", confidence: 0.2 }));
    const controller = new AbortController();
    const loop = runWorkerLoop(main, new InMemoryIdempotencyStore(), {
      workerId: "w-unplaced",
      correlationId: "scale-test",
      signal: controller.signal,
      reviewQueue: brokenQueue(),
      idlePollMs: 20,
    });
    const deadline = Date.now() + 5000;
    while (!lines(error).some((l) => l.event === "worker_job_unplaced") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect((await loop).stoppedBecause).toBe("signal");
    expect(lines(error).find((l) => l.event === "worker_job_unplaced")).toMatchObject({ correlationId: "corr-u-1", errorClass: "ReviewRouteFailedError" });
  });
});

describe("processJob guard (no Redis needed)", () => {
  it("refuses to auto-resolve a low-confidence job even when called directly, and logs why", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    expect(processJob(job({ correlationId: "corr-g", confidence: 0.1 }), store)).toEqual({ status: "needs_review" });
    expect(lines(warn).find((l) => l.event === "job_not_auto_resolved")).toMatchObject({ correlationId: "corr-g", outcome: "skipped" });
    expect(lines(log).some((l) => l.event === "job_processed")).toBe(false);
    expect(store.claim("idem-1")).toBe(true);
  });

  it("a job with no confidence field (not a classification) is processed normally", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(processJob(job(), new InMemoryIdempotencyStore())).toEqual({ status: "processed" });
  });
});
