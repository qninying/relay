// Integration: callExternalApiAndPersist's DLQ wiring (STORY-004), against a
// real Redis DLQ stream — proves a job whose retries are exhausted actually
// lands in the DLQ and can be triaged back out, not just that the function
// returns a particular status string.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { callExternalApiAndPersist } from "./callExternalApi.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { triageNextDeadLetterEntry } from "./dlq.js";
import type { Job } from "./processJob.js";
import type { JobOutputSchema } from "../guardrails/outputContractGuardrail.js";

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
    "[callExternalApiDlq.test.ts] Redis not reachable at localhost:6379 — skipped. Run `docker compose up -d redis` first."
  );
}

function schema(): JobOutputSchema {
  return { jobType: "lead_enrichment", requiredFields: ["industry"], allowedFields: new Set(["industry"]) };
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return { id: "job-1", correlationId: "corr-1", idempotencyKey: "idem-1", payload: { x: 1 }, ...overrides };
}

const reliabilityOptions = { timeoutMs: 1000, maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100 };

describe.skipIf(!redisAvailable)("callExternalApiAndPersist DLQ wiring (integration, real Redis)", () => {
  const streamKey = `relay:dlq:test:${Math.random().toString(36).slice(2)}`;
  const groupName = "relay-dlq-callapi-group";
  let dlq: RedisStreamQueue;

  beforeAll(async () => {
    dlq = new RedisStreamQueue(redis, streamKey, groupName);
    await dlq.ensureConsumerGroup();
  });

  afterAll(async () => {
    await redis.del(streamKey);
    await redis.quit();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves the job to the real DLQ when retries are exhausted, and it can be triaged back out (criterion 1, composed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 10, windowMs: 60_000, cooldownMs: 30_000 });
    const apiCall = vi.fn().mockRejectedValue(new Error("upstream down"));
    const job = baseJob({ id: "job-dlq-1", correlationId: "corr-dlq-e2e-1" });

    const promise = callExternalApiAndPersist(
      apiCall,
      schema(),
      job.correlationId,
      breaker,
      reliabilityOptions,
      { job, dlq }
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe("moved_to_dlq");

    vi.useRealTimers();
    const triaged = await triageNextDeadLetterEntry(dlq, "verify-consumer");
    expect(triaged).toMatchObject({ jobId: "job-dlq-1" });
  });

  it("does NOT move the job to the DLQ when the circuit is open — the call was never attempted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 30_000 });
    breaker.recordFailure(); // opens after 1 failure
    const apiCall = vi.fn().mockResolvedValue({ industry: "software" });
    const job = baseJob({ id: "job-circuit-open", correlationId: "corr-dlq-e2e-2" });

    const result = await callExternalApiAndPersist(
      apiCall,
      schema(),
      job.correlationId,
      breaker,
      reliabilityOptions,
      { job, dlq }
    );

    expect(result).toEqual({ status: "call_failed", errorClass: "CircuitOpenError" });
    expect(apiCall).not.toHaveBeenCalled();

    vi.useRealTimers();
    const triaged = await triageNextDeadLetterEntry(dlq, "verify-consumer");
    expect(triaged).toBeNull(); // nothing was moved to the DLQ
  });
});
