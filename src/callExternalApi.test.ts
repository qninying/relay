import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callExternalApiAndPersist } from "./callExternalApi.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import type { JobOutputSchema } from "../guardrails/outputContractGuardrail.js";

function schema(): JobOutputSchema {
  return {
    jobType: "lead_enrichment",
    requiredFields: ["industry"],
    allowedFields: new Set(["industry", "confidence"]),
  };
}

const reliabilityOptions = { timeoutMs: 1000, maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 };

describe("callExternalApiAndPersist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("proceeds and persists when the circuit is closed and the call and output are both valid (criterion 1 + trust)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
    const apiCall = vi.fn().mockResolvedValue({ industry: "software", confidence: 0.9 });

    const result = await callExternalApiAndPersist(apiCall, schema(), "corr-1", breaker, reliabilityOptions);

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "persisted" });
    expect(breaker.getState()).toBe("closed");
  });

  it("blocks the call without invoking it when the circuit is open (criterion 2)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 30_000 });
    breaker.recordFailure(); // opens after 1 failure
    expect(breaker.getState()).toBe("open");
    const apiCall = vi.fn().mockResolvedValue({ industry: "software" });

    const result = await callExternalApiAndPersist(apiCall, schema(), "corr-2", breaker, reliabilityOptions);

    expect(apiCall).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "call_failed", errorClass: "CircuitOpenError" });
  });

  it("calls the API but refuses to persist when the returned output fails schema validation (trust: validated before persisting)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
    const apiCall = vi.fn().mockResolvedValue({ notDeclaredInSchema: true }); // missing required "industry"

    const result = await callExternalApiAndPersist(apiCall, schema(), "corr-3", breaker, reliabilityOptions);

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("validation_failed");
  });

  it("reports call_failed and never reaches validation when the API call exhausts all retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 10, windowMs: 60_000, cooldownMs: 30_000 });
    const apiCall = vi.fn().mockRejectedValue(new Error("upstream down"));

    const promise = callExternalApiAndPersist(apiCall, schema(), "corr-4", breaker, reliabilityOptions);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(apiCall).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(result).toEqual({ status: "call_failed", errorClass: "UpstreamCallFailedError" });
  });

  it("threads the same correlation ID through the whole chain, success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
    const apiCall = vi.fn().mockResolvedValue({ industry: "software" });

    await callExternalApiAndPersist(apiCall, schema(), "corr-thread-me", breaker, reliabilityOptions);

    const lines = logSpy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
    expect(lines.every((l) => l.correlationId === "corr-thread-me")).toBe(true);
  });
});
