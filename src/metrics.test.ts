import { describe, it, expect, vi, afterEach } from "vitest";
import { MetricsCollector } from "./metrics.js";

function logLines(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
}

describe("MetricsCollector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports null, not a fabricated 0 or 100%, when nothing has been recorded yet (metrics are inaccurate: avoided)", () => {
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });
    const snapshot = collector.snapshot();

    expect(snapshot.successRate).toBeNull();
    expect(snapshot.p95LatencyMs).toBeNull();
    expect(snapshot.totalRequests).toBe(0);
  });

  it("computes success rate from recorded outcomes (happy path)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });

    collector.record("success", 100, "corr-1");
    collector.record("success", 120, "corr-2");
    collector.record("failure", 90, "corr-3");

    const snapshot = collector.snapshot();
    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.successCount).toBe(2);
    expect(snapshot.failureCount).toBe(1);
    expect(snapshot.successRate).toBeCloseTo(2 / 3);
  });

  it("updates the snapshot immediately after each record() call, with no separate flush step (criterion 1: updated live)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });

    expect(collector.snapshot().totalRequests).toBe(0);
    collector.record("success", 100, "corr-1");
    expect(collector.snapshot().totalRequests).toBe(1);
    collector.record("success", 100, "corr-2");
    expect(collector.snapshot().totalRequests).toBe(2);
  });

  it("computes p95 latency using the nearest-rank method over the recorded window", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 100, targetSuccessRate: 0.99 });

    for (let ms = 1; ms <= 100; ms++) {
      collector.record("success", ms, `corr-${ms}`);
    }

    expect(collector.snapshot().p95LatencyMs).toBe(95);
  });

  it("keeps only the most recent windowSize records, evicting the oldest (boundary: rolling window)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 3, targetSuccessRate: 0.99 });

    collector.record("failure", 10, "corr-1");
    collector.record("success", 10, "corr-2");
    collector.record("success", 10, "corr-3");
    collector.record("success", 10, "corr-4"); // evicts the failure from corr-1

    const snapshot = collector.snapshot();
    expect(snapshot.totalRequests).toBe(3);
    expect(snapshot.successRate).toBe(1); // the one failure aged out of the window
  });

  it("reflects a failure in the error budget immediately (criterion 2: error occurs -> reflected in error budget)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 100, targetSuccessRate: 0.99 });

    for (let i = 0; i < 99; i++) collector.record("success", 10, `corr-ok-${i}`);
    const beforeFailure = collector.snapshot().errorBudget;
    expect(beforeFailure.breached).toBe(false);

    collector.record("failure", 10, "corr-fail");
    const afterFailure = collector.snapshot().errorBudget;

    expect(afterFailure.actualFailures).toBe(1);
    expect(afterFailure.remaining).toBeLessThan(beforeFailure.remaining);
  });

  it("marks the error budget breached once actual failures exceed what the target success rate allows (error budget is tracked)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.5 }); // allows up to half to fail

    collector.record("success", 10, "corr-ok-1");
    collector.record("failure", 10, "corr-fail-1");
    // total=2, allowed=2*0.5=1.0, actual=1, remaining=0.0 — exactly at budget, not yet negative
    expect(collector.snapshot().errorBudget.breached).toBe(false);

    collector.record("failure", 10, "corr-fail-2");
    // total=3, allowed=3*0.5=1.5, actual=2, remaining=-0.5 — over budget
    expect(collector.snapshot().errorBudget.breached).toBe(true);
  });

  it("logs every recorded metric with its correlation ID (trust)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });

    collector.record("success", 50, "corr-trust-1");
    collector.record("failure", 60, "corr-trust-2");

    const lines = logLines(spy);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "slo_metric_recorded", correlationId: "corr-trust-1", outcome: "success", durationMs: 50 });
    expect(lines[1]).toMatchObject({ event: "slo_metric_recorded", correlationId: "corr-trust-2", outcome: "failure", durationMs: 60 });
  });

  it("exposes recent samples in chronological order, for a real (not invented) recent-activity trend", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });

    collector.record("success", 10, "corr-1");
    collector.record("failure", 20, "corr-2");
    collector.record("success", 30, "corr-3");

    const samples = collector.snapshot().recentSamples;
    expect(samples).toEqual([
      { outcome: "success", durationMs: 10 },
      { outcome: "failure", durationMs: 20 },
      { outcome: "success", durationMs: 30 },
    ]);
  });

  it("caps recent samples at 20, keeping the most recent, even with a larger window", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.99 });

    for (let i = 0; i < 30; i++) collector.record("success", i, `corr-${i}`);

    const samples = collector.snapshot().recentSamples;
    expect(samples).toHaveLength(20);
    expect(samples[0].durationMs).toBe(10); // the oldest of the last 20 (indices 10..29)
    expect(samples[19].durationMs).toBe(29);
  });
});
