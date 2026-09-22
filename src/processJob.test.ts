import { describe, it, expect, vi, afterEach } from "vitest";
import { processJob, type Job } from "./processJob.js";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotencyStore.js";
import { MetricsCollector } from "./metrics.js";

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

describe("processJob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes a new job and logs it with a correlation ID (happy path, criterion 1)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();

    const result = processJob(baseJob(), store);

    expect(result).toEqual({ status: "processed" });
    const lines = logLines(spy);
    expect(lines.map((l) => l.event)).toEqual(["job_received", "job_processed"]);
    expect(lines.every((l) => l.correlationId === "corr-1")).toBe(true);
    expect(lines[1].outcome).toBe("success");
  });

  it("does not double-process a re-delivered job (criterion 2)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const job = baseJob();

    const first = processJob(job, store);
    const second = processJob(job, store);

    expect(first).toEqual({ status: "processed" });
    expect(second).toEqual({ status: "skipped_duplicate" });
  });

  it("logs the duplicate with its correlation ID too, not silently (criterion 3: trust)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const job = baseJob();

    processJob(job, store);
    processJob(job, store);

    const lines = logLines(spy);
    expect(lines.every((l) => l.correlationId === "corr-1")).toBe(true);
    expect(lines.map((l) => l.event)).toEqual(["job_received", "job_processed", "job_received", "job_skipped_duplicate"]);
  });

  it("re-delivery with a different job id but the same idempotency key is still a duplicate", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();

    const first = processJob(baseJob({ id: "job-1" }), store);
    const second = processJob(baseJob({ id: "job-1-retry" }), store);

    expect(first.status).toBe("processed");
    expect(second.status).toBe("skipped_duplicate");
  });

  it("returns failed and logs with an error class when the store itself fails (failure path)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenStore: IdempotencyStore = {
      claim: () => {
        throw new Error("store unavailable");
      },
    };

    const result = processJob(baseJob(), brokenStore);

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ errorClass: "Error" });
    expect(logSpy).toHaveBeenCalledTimes(1); // job_received only
    expect(errorSpy).toHaveBeenCalledTimes(1); // job_failed
    const failureLine = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(failureLine).toMatchObject({ event: "job_failed", correlationId: "corr-1", outcome: "failure", errorClass: "Error" });
  });

  it("is safe to call twice with the same job object without mutating it", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const job = baseJob();
    const snapshot = JSON.parse(JSON.stringify(job));

    processJob(job, store);
    processJob(job, store);

    expect(job).toEqual(snapshot);
  });

  it("records a successful job in the metrics collector when one is provided (STORY-005 wiring)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const metrics = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });

    processJob(baseJob(), store, metrics);

    const snapshot = metrics.snapshot();
    expect(snapshot.totalRequests).toBe(1);
    expect(snapshot.successCount).toBe(1);
  });

  it("records a failed job in the metrics collector, not a success", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenStore: IdempotencyStore = {
      claim: () => {
        throw new Error("store unavailable");
      },
    };
    const metrics = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });

    processJob(baseJob(), brokenStore, metrics);

    const snapshot = metrics.snapshot();
    expect(snapshot.totalRequests).toBe(1);
    expect(snapshot.failureCount).toBe(1);
    expect(snapshot.successCount).toBe(0);
  });

  it("does not record a skipped duplicate in the metrics collector at all", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();
    const metrics = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });
    const job = baseJob();

    processJob(job, store, metrics); // processed -> recorded
    processJob(job, store, metrics); // skipped_duplicate -> NOT recorded

    expect(metrics.snapshot().totalRequests).toBe(1);
  });

  it("still works exactly as before when no metrics collector is passed (backward compatible)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new InMemoryIdempotencyStore();

    const result = processJob(baseJob(), store);

    expect(result).toEqual({ status: "processed" });
  });
});
