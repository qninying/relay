// Integration tests against a REAL local Redis (docker compose up -d redis),
// not a mock — REQ-001 requires an actual durable queue, so faking the Redis
// client would prove nothing about whether Streams actually work. Skips
// cleanly with a clear reason if Redis isn't reachable, rather than failing
// opaquely in an environment without Docker.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
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
    "[queue.test.ts] Redis not reachable at localhost:6379 — integration tests skipped. Run `docker compose up -d redis` first."
  );
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    payload: { hello: "world" },
    ...overrides,
  };
}

function logLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
}

describe.skipIf(!redisAvailable)("RedisStreamQueue (integration, real Redis)", () => {
  const streamKey = `relay:test:${Math.random().toString(36).slice(2)}`;
  const groupName = "relay-test-group";
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

  it("ensureConsumerGroup is idempotent — calling it twice does not throw (BUSYGROUP handled)", async () => {
    await expect(queue.ensureConsumerGroup()).resolves.toBeUndefined();
  });

  it("enqueues and dequeues a job through real Redis Streams (happy path, criterion 1)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = baseJob({ id: "job-happy" });

    const { messageId } = await queue.enqueue(job);
    expect(messageId).toMatch(/^\d+-\d+$/);

    const dequeued = await queue.dequeueOne("consumer-1");
    expect(dequeued).toMatchObject({ id: "job-happy", correlationId: "corr-1" });

    const events = logLines(spy).map((l) => l.event);
    expect(events).toContain("job_dequeued");
    expect(logLines(spy).find((l) => l.event === "job_dequeued")?.correlationId).toBe("corr-1");
  });

  it("returns null when the stream has nothing new to read", async () => {
    const result = await queue.dequeueOne("consumer-1");
    expect(result).toBeNull();
  });

  it("logs job_low_confidence with the correlation ID for a low-confidence job (criterion 2)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = baseJob({ id: "job-low-conf", correlationId: "corr-low", confidence: 0.2 });
    await queue.enqueue(job);
    await queue.dequeueOne("consumer-1");

    const lowConfLine = logLines(spy).find((l) => l.event === "job_low_confidence");
    expect(lowConfLine).toBeDefined();
    expect(lowConfLine?.correlationId).toBe("corr-low");
  });

  it("does not log job_low_confidence for a normal-confidence job", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = baseJob({ id: "job-normal-conf", correlationId: "corr-normal", confidence: 0.9 });
    await queue.enqueue(job);
    await queue.dequeueOne("consumer-1");

    expect(logLines(spy).find((l) => l.event === "job_low_confidence")).toBeUndefined();
  });

  it("acks the message so it leaves the consumer group's pending list (trust: traceable, not stuck)", async () => {
    const job = baseJob({ id: "job-ack-check" });
    await queue.enqueue(job);
    await queue.dequeueOne("consumer-1");

    const pending = await redis.xpending(streamKey, groupName);
    expect(pending[0]).toBe(0);
  });

  it("rejects an enqueue when the connection is broken, and logs the failure (failure path)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenRedis = new Redis({ port: 1, lazyConnect: true, retryStrategy: () => null, connectTimeout: 300, maxRetriesPerRequest: 0 });
    // Without a listener, ioredis prints its own "[ioredis] Unhandled error
    // event" via console.error on top of queue.ts's own job_enqueue_failed
    // log — found by this test actually failing on a real broken connection,
    // not assumed. Our own structured log below is the one that matters;
    // this just stops ioredis's internal fallback from doubling the count.
    brokenRedis.on("error", () => {});
    const brokenQueue = new RedisStreamQueue(brokenRedis, streamKey, groupName);
    const job = baseJob({ id: "job-broken" });

    await expect(brokenQueue.enqueue(job)).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ event: "job_enqueue_failed", correlationId: "corr-1", outcome: "failure" });
    brokenRedis.disconnect();
  });
});
