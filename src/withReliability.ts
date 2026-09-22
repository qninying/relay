// REQ-003's other half: an explicit timeout and capped retry with backoff
// around any external API call, composable with an optional CircuitBreaker.
// Ported from the same pattern proven in CoreOps's mcp-server/src/reliability/.
// Decoupled from any specific upstream so it can wrap whatever async call
// this story (or a later one) needs it for.

import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";

export interface ReliabilityOptions {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitBreaker?: CircuitBreaker;
  onAttempt?: (attempt: number, maxAttempts: number) => void;
}

export class UpstreamTimeoutError extends Error {
  readonly errorClass = "UpstreamTimeoutError" as const;

  constructor(readonly timeoutMs: number) {
    super(`Upstream call timed out after ${timeoutMs}ms.`);
    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamCallFailedError extends Error {
  readonly errorClass = "UpstreamCallFailedError" as const;

  constructor(readonly attempts: number, cause: unknown) {
    super(
      `Upstream call failed after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "UpstreamCallFailedError";
    this.cause = cause;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpstreamTimeoutError(timeoutMs)), timeoutMs);
    operation()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// Exponential backoff: baseDelayMs * 2^(attempt-1), capped at maxDelayMs.
// attempt is 1-indexed (the delay is for the wait *after* this attempt
// failed, before the next).
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

// Re-checks circuit availability before every attempt, not just once up
// front — if this call's own failures push the circuit open mid-retry,
// remaining retries are abandoned in favor of failing fast rather than
// continuing to hammer a known-broken upstream.
export async function withReliability<T>(
  operation: () => Promise<T>,
  options: ReliabilityOptions
): Promise<T> {
  const { timeoutMs, maxRetries, baseDelayMs, maxDelayMs, circuitBreaker, onAttempt } = options;
  const maxAttempts = maxRetries + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onAttempt?.(attempt, maxAttempts);

    if (circuitBreaker) {
      const retryAfterMs = circuitBreaker.checkAvailability();
      if (retryAfterMs !== null) {
        throw new CircuitOpenError(retryAfterMs);
      }
    }

    try {
      const result = await withTimeout(operation, timeoutMs);
      circuitBreaker?.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      circuitBreaker?.recordFailure();
      if (attempt < maxAttempts) {
        await delay(backoffDelay(attempt, baseDelayMs, maxDelayMs));
      }
    }
  }

  throw new UpstreamCallFailedError(maxAttempts, lastError);
}
