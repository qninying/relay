// Integration tests against a REAL local Redis (docker compose up -d redis),
// same convention as queue.test.ts — the DLQ is a real stream, so faking it
// would prove nothing about whether entries actually survive and can be
// read back.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { moveToDeadLetterQueue, triageNextDeadLetterEntry } from "./dlq.js";
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
    "[dlq.test.ts] Redis not reachable at localhost:6379 — DLQ tests skipped. Run `docker compose up -d redis` first."
  );
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    correlationId: "corr-dlq-1",
    idempotencyKey: "idem-dlq-1",
    payload: { hello: "world" },
    ...overrides,
  };
}

function logLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
}

describe.skipIf(!redisAvailable)("dead-letter queue (integration, real Redis)", () => {
  const streamKey = `relay:dlq:test:${Math.random().toString(36).slice(2)}`;
  const groupName = "relay-dlq-test-group";
  let dlq: RedisStreamQueue;

  beforeAll(async () => {
    dlq = new RedisStreamQueue(redis, streamKey, groupName);
    await dlq.ensureConsumerGroup();
  });

  afterAll(async () => {
    await redis.del(streamKey);
    await redis.quit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves a job to the DLQ and logs it with the correlation ID (criterion 1)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = baseJob({ id: "job-exhausted" });

    await moveToDeadLetterQueue(dlq, job, "upstream unavailable after 3 attempts");

    const line = logLines(warnSpy).find((l) => l.event === "job_moved_to_dlq");
    expect(line).toBeDefined();
    expect(line?.correlationId).toBe("corr-dlq-1");

    // Drain what this test produced — tests in this file share one DLQ
    // stream, same convention as queue.test.ts, so each test must dequeue
    // whatever it enqueues or a later test's dequeueOne() picks up this
    // leftover entry instead of its own (Streams read oldest-first).
    vi.spyOn(console, "log").mockImplementation(() => {});
    await triageNextDeadLetterEntry(dlq, "cleanup-consumer");
  });

  it("triages the next DLQ entry, logging it with its failure reason (criterion 2)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = baseJob({ id: "job-triage-me", correlationId: "corr-dlq-2", idempotencyKey: "idem-dlq-2" });

    await moveToDeadLetterQueue(dlq, job, "circuit open for 5 minutes");
    const result = await triageNextDeadLetterEntry(dlq, "triage-consumer");

    expect(result).toEqual({ jobId: "job-triage-me", failureReason: "circuit open for 5 minutes" });

    const dequeuedLine = logLines(logSpy).find((l) => l.event === "job_dequeued");
    expect(dequeuedLine?.correlationId).toBe("corr-dlq-2");
    const triagedLine = logLines(warnSpy).find((l) => l.event === "job_triaged");
    expect(triagedLine).toBeDefined();
    expect(triagedLine?.correlationId).toBe("corr-dlq-2");
    expect((triagedLine?.context as Record<string, unknown>)?.failureReason).toBe("circuit open for 5 minutes");
  });

  it("returns null when there is nothing new in the DLQ to triage", async () => {
    const result = await triageNextDeadLetterEntry(dlq, "triage-consumer");
    expect(result).toBeNull();
  });

  it("preserves the original job payload inside the DLQ entry, not just the failure reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const job = baseJob({
      id: "job-payload-check",
      correlationId: "corr-dlq-3",
      idempotencyKey: "idem-dlq-3",
      payload: { leadId: "acme-123" },
    });

    await moveToDeadLetterQueue(dlq, job, "timeout");

    const raw = await redis.xrange(streamKey, "-", "+", "COUNT", 100);
    const lastEntry = raw[raw.length - 1];
    const fields = lastEntry[1];
    const dataField = fields[fields.indexOf("data") + 1];
    const parsed = JSON.parse(dataField);

    expect(parsed.payload.originalPayload).toEqual({ leadId: "acme-123" });
    expect(parsed.payload.failureReason).toBe("timeout");

    await triageNextDeadLetterEntry(dlq, "cleanup-consumer"); // drain, same reason as above
  });

  it("logs every DLQ entry with a correlation ID, move and triage alike (trust)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const job = baseJob({ id: "job-trust-check", correlationId: "corr-dlq-trust", idempotencyKey: "idem-dlq-trust" });

    await moveToDeadLetterQueue(dlq, job, "validation failed");
    await triageNextDeadLetterEntry(dlq, "triage-consumer");

    const lines = logLines(warnSpy);
    expect(lines.every((l) => l.correlationId === "corr-dlq-trust")).toBe(true);
    expect(lines.map((l) => l.event)).toEqual(["job_moved_to_dlq", "job_triaged"]);
  });
});
