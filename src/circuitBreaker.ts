// REQ-003: a circuit breaker in front of every external API call, with a
// documented fail-fast path. Pure state machine — closed/open/half-open, a
// sliding failure window, no I/O and no knowledge of what it's protecting.
// It does not call the wrapped operation itself; see withReliability.ts for
// the timeout/retry wrapper that reports into this class. Ported from the
// same pattern already proven in CoreOps's mcp-server/src/reliability/.

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  readonly errorClass = "CircuitOpenError" as const;

  constructor(readonly retryAfterMs: number) {
    super(`Circuit is open; retry after ${retryAfterMs}ms.`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  getState(): CircuitState {
    return this.state;
  }

  // Returns null if a call may proceed (closed, or open-but-cooldown-elapsed,
  // which transitions to half-open as a side effect). Returns the remaining
  // cooldown in ms if the call must be rejected without being attempted —
  // this is REQ-003's fail-fast path.
  checkAvailability(): number | null {
    if (this.state === "closed" || this.state === "half-open") {
      return null;
    }

    const elapsed = this.now() - (this.openedAt ?? this.now());
    const remaining = this.options.cooldownMs - elapsed;
    if (remaining <= 0) {
      this.state = "half-open";
      return null;
    }
    return remaining;
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.state = "closed";
      this.failureTimestamps = [];
      this.openedAt = null;
    }
  }

  recordFailure(): void {
    const now = this.now();

    if (this.state === "half-open") {
      // A single failed trial call reopens immediately — no need to
      // re-accumulate failureThreshold failures before tripping again.
      this.state = "open";
      this.openedAt = now;
      this.failureTimestamps = [now];
      return;
    }

    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter(
      (ts) => now - ts <= this.options.windowMs
    );

    if (this.failureTimestamps.length >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }
}
