import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withReliability, UpstreamCallFailedError } from "./withReliability.js";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";

// Fake timers so timeout/backoff delays are advanced instantly rather than
// actually waited for — this suite would otherwise take real seconds.

describe("withReliability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on the first successful attempt without retrying (happy path)", async () => {
    const operation = vi.fn().mockResolvedValue("ok");

    const result = await withReliability(operation, { timeoutMs: 1000, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure and succeeds on the second attempt", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");

    const promise = withReliability(operation, { timeoutMs: 1000, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("throws UpstreamCallFailedError after exhausting all retries (failure path)", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("always fails"));

    const promise = withReliability(operation, { timeoutMs: 1000, maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 });
    const assertion = expect(promise).rejects.toThrow(UpstreamCallFailedError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("times out an operation that never resolves, wrapped as UpstreamCallFailedError (API call times out)", async () => {
    const operation = vi.fn(() => new Promise<never>(() => {})); // never settles

    const promise = withReliability(operation, { timeoutMs: 500, maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 });
    const assertion = expect(promise).rejects.toThrow(UpstreamCallFailedError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("fails fast with CircuitOpenError when the breaker is open, without calling the operation (circuit breaker open -> call is blocked)", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 30_000 });
    breaker.recordFailure(); // opens after 1 failure
    expect(breaker.getState()).toBe("open");
    const operation = vi.fn().mockResolvedValue("should not run");

    await expect(
      withReliability(operation, { timeoutMs: 1000, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100, circuitBreaker: breaker })
    ).rejects.toThrow(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();
  });

  it("proceeds and records success on the breaker when it is closed (circuit breaker closed -> call proceeds)", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
    const operation = vi.fn().mockResolvedValue("ok");

    const result = await withReliability(operation, {
      timeoutMs: 1000,
      maxRetries: 0,
      baseDelayMs: 10,
      maxDelayMs: 100,
      circuitBreaker: breaker,
    });

    expect(result).toBe("ok");
    expect(breaker.getState()).toBe("closed");
  });

  it("abandons remaining retries and fails fast once the circuit opens mid-retry", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 30_000 });
    const operation = vi.fn().mockRejectedValue(new Error("boom"));

    const promise = withReliability(operation, {
      timeoutMs: 1000,
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      circuitBreaker: breaker,
    });
    const assertion = expect(promise).rejects.toThrow(CircuitOpenError);
    await vi.runAllTimersAsync();
    await assertion;

    // Attempt 1 fails and opens the breaker (threshold 1); attempt 2 is
    // blocked before the operation is called again.
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
