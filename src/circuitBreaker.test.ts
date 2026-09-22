import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "./circuitBreaker.js";

// Direct unit tests of the state machine, using the injectable `now` clock
// instead of fake timers — pure logic, no I/O, so this is testable at full
// precision with no real (or simulated) waiting at all.

function makeClock(startAt = 0) {
  let time = startAt;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("CircuitBreaker", () => {
  it("stays closed and available while failures remain below the threshold (happy path)", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 4; i++) breaker.recordFailure();

    expect(breaker.getState()).toBe("closed");
    expect(breaker.checkAvailability()).toBeNull();
  });

  it("opens once failures reach the threshold within the window (failure path: fails to open until threshold)", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 5; i++) breaker.recordFailure();

    expect(breaker.getState()).toBe("open");
    expect(breaker.checkAvailability()).not.toBeNull();
  });

  it("does not count failures that have aged out of the sliding window (boundary)", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 4; i++) breaker.recordFailure(); // 4 failures at t=0
    clock.advance(61_000); // past the 60s window — those 4 no longer count
    breaker.recordFailure(); // only 1 failure "in window" now

    expect(breaker.getState()).toBe("closed");
  });

  it("reports the remaining cooldown while open, rather than a boolean", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 5; i++) breaker.recordFailure(); // opens at t=0
    clock.advance(10_000); // 10s into the 30s cooldown

    expect(breaker.checkAvailability()).toBe(20_000);
  });

  it("transitions to half-open once the cooldown elapses, allowing exactly one trial through", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 5; i++) breaker.recordFailure();
    clock.advance(30_000);

    expect(breaker.checkAvailability()).toBeNull(); // the trial is allowed through
    expect(breaker.getState()).toBe("half-open");
  });

  it("closes and clears failure history after a successful half-open trial", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 5; i++) breaker.recordFailure();
    clock.advance(30_000);
    breaker.checkAvailability(); // -> half-open
    breaker.recordSuccess();

    expect(breaker.getState()).toBe("closed");

    for (let i = 0; i < 4; i++) breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("reopens immediately if the half-open trial call fails, without re-accumulating the threshold", () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000, now: clock.now });

    for (let i = 0; i < 5; i++) breaker.recordFailure();
    clock.advance(30_000);
    breaker.checkAvailability(); // -> half-open
    breaker.recordFailure(); // the single trial call failed

    expect(breaker.getState()).toBe("open");
    expect(breaker.checkAvailability()).toBe(30_000);
  });
});
