// Composes queue.ts (STORY-002) with processJob.ts (STORY-001) against a real
// local Redis — proves the full chain (enqueue -> dequeue -> idempotency check
// -> log) actually works together, not just each piece in isolation. Each
// module's own test file already covers it alone; this is the gap flagged in
// review: "processJob() is proven correct in isolation, but composing it with
// dequeueOne() end to end hasn't been tested together as one flow."

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { processJob } from "./processJob.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";
import type { Job } from "./processJob.js";

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
  console.warn(
    "[endToEnd.test.ts] Redis not reachable at localhost:6379 — end-to-end tests skipped. Run `docker compose up -d redis` first."
  );
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    correlationId: "corr-e2e-1",
    idempotencyKey: "idem-e2e-1",
    payload: { hello: "world" },
    ...overrides,
  };
}

function logEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
}

describe.skipIf(!redisAvailable)("end-to-end: enqueue -> dequeue -> processJob (real Redis)", () => {
  const streamKey = `relay:e2e:${Math.random().toString(36).slice(2)}`;
  const groupName = "relay-e2e-group";
  let queue: RedisStreamQueue;

  beforeAll(async () => {
    queue = new RedisStreamQueue(redis, streamKey, groupName);
    await queue.ensureConsumerGroup();
  });

  afterAll(async () => {
    await redis.del(streamKey);
    await redis.quit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a job submitted through the real queue is processed and logged with one consistent correlation ID end to end", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const job = baseJob();

    await queue.enqueue(job);
    const dequeued = await queue.dequeueOne("consumer-e2e");
    expect(dequeued).not.toBeNull();

    const result = processJob(dequeued!, store);

    expect(result).toEqual({ status: "processed" });
    const events = logEvents(spy);
    expect(events.map((e) => e.event)).toEqual(["job_dequeued", "job_received", "job_processed"]);
    expect(events.every((e) => e.correlationId === "corr-e2e-1")).toBe(true);
  });

  it("a job re-delivered through the real queue (e.g. a retry before ack) is skipped as a duplicate by processJob, not reprocessed", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const job = baseJob({ id: "job-2", correlationId: "corr-e2e-2", idempotencyKey: "idem-e2e-2" });

    await queue.enqueue(job);
    const first = await queue.dequeueOne("consumer-e2e");
    const firstResult = processJob(first!, store);

    // Re-delivery: the same job re-enqueued and read again, same idempotency key.
    await queue.enqueue(job);
    const second = await queue.dequeueOne("consumer-e2e");
    const secondResult = processJob(second!, store);

    expect(firstResult).toEqual({ status: "processed" });
    expect(secondResult).toEqual({ status: "skipped_duplicate" });

    const events = logEvents(spy);
    expect(events.filter((e) => e.event === "job_processed")).toHaveLength(1);
    expect(events.filter((e) => e.event === "job_skipped_duplicate")).toHaveLength(1);
    expect(events.every((e) => e.correlationId === "corr-e2e-2")).toBe(true);
  });

  it("a low-confidence job's classification signal survives the queue round-trip unchanged", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const job = baseJob({ id: "job-3", correlationId: "corr-e2e-3", idempotencyKey: "idem-e2e-3", confidence: 0.1 });

    await queue.enqueue(job);
    const dequeued = await queue.dequeueOne("consumer-e2e");

    expect(dequeued?.confidence).toBe(0.1);
    expect(processJob(dequeued!, store)).toEqual({ status: "processed" });
  });
});
