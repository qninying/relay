import { describe, it, expect, vi, afterEach } from "vitest";
import { runWorkerLoop } from "./workerLoop.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";
import type { Job } from "./processJob.js";
import type { RedisStreamQueue } from "./queue.js";

function job(n: number): Job {
  return { id: `job-${n}`, correlationId: `corr-${n}`, idempotencyKey: `idem-${n}`, payload: {} };
}

function fakeQueue(script: Array<Job | null | Error>, onEmpty?: () => void): RedisStreamQueue {
  let i = 0;
  return {
    dequeueOne: async () => {
      if (i >= script.length) {
        onEmpty?.();
        return null;
      }
      const next = script[i++];
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as RedisStreamQueue;
}

afterEach(() => vi.restoreAllMocks());

describe("runWorkerLoop", () => {
  it("processes every job it dequeues until signalled to stop", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = new AbortController();
    const queue = fakeQueue([job(1), job(2), null, job(3)], () => controller.abort());
    const result = await runWorkerLoop(queue, new InMemoryIdempotencyStore(), {
      workerId: "w1",
      correlationId: "scale-1",
      signal: controller.signal,
      idlePollMs: 1,
    });
    expect(result).toEqual({ processed: 3, stoppedBecause: "signal" });
  });

  it("recovers from a transient dequeue error, logging it with the worker's correlation ID", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const queue = fakeQueue([new Error("ECONNRESET"), job(1)], () => controller.abort());
    const result = await runWorkerLoop(queue, new InMemoryIdempotencyStore(), {
      workerId: "w1",
      correlationId: "scale-1",
      signal: controller.signal,
      errorBackoffMs: 1,
      idlePollMs: 1,
    });
    expect(result.processed).toBe(1);
    expect(JSON.parse(errors.mock.calls[0][0] as string)).toMatchObject({
      event: "worker_dequeue_failed",
      correlationId: "scale-1",
      context: { workerId: "w1", consecutiveErrors: 1 },
    });
  });

  it("gives up after maxConsecutiveErrors instead of retrying forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = fakeQueue([new Error("down"), new Error("down"), new Error("down")]);
    const result = await runWorkerLoop(queue, new InMemoryIdempotencyStore(), {
      workerId: "w1",
      correlationId: "scale-1",
      signal: new AbortController().signal,
      errorBackoffMs: 1,
      maxConsecutiveErrors: 3,
    });
    expect(result).toEqual({ processed: 0, stoppedBecause: "too_many_errors" });
  });

  it("stops promptly while idle, without waiting out the poll interval", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    await runWorkerLoop(fakeQueue([]), new InMemoryIdempotencyStore(), {
      workerId: "w1",
      correlationId: "scale-1",
      signal: controller.signal,
      idlePollMs: 60_000,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
