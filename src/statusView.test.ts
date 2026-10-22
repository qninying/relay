// STORY-010: the plain-language status view and the outcome tracker that
// feeds monitoring. Pure, no Redis.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildStatus, renderStatusHtml } from "./statusView.js";
import { JobOutcomeTracker, enqueuedAtMs } from "./jobOutcomeTracker.js";
import { MetricsCollector } from "./metrics.js";
import type { MetricsSample } from "./monitoringSampler.js";

const NOW = Date.parse("2026-10-22T19:00:00Z");
const base = { now: NOW, sampleIntervalMs: 60_000, targetSuccessRate: 0.9 };

function sample(overrides: Partial<MetricsSample> = {}): MetricsSample {
  return {
    sampleId: "s1",
    at: new Date(NOW - 20_000).toISOString(),
    intervalMs: 60_000,
    successRate: 0.98,
    p95LatencyMs: 1200,
    windowJobs: 200,
    processed: 50,
    failed: 1,
    movedToDlq: 0,
    dlqDepth: 0,
    routedToReview: 0,
    reviewDepth: 0,
    queueDepth: 0,
    pending: 0,
    workers: 2,
    breakerTrips: null,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("buildStatus: plain language for analysts", () => {
  it("healthy: says so in words, with the numbers an analyst needs and no jargon", () => {
    const r = buildStatus({ ...base, sample: sample(), error: null });
    expect(r.state).toBe("ok");
    expect(r.headline).toBe("Relay is running normally.");
    expect(r.details).toContain("98% of the last 200 jobs succeeded (target 90%).");
    expect(r.details).toContain("Most jobs (95 in 100) finish within about 1.2 seconds of being submitted.");
    expect(r.details).toContain("Nothing is waiting to start.");
    expect(r.updated).toBe("Updated about 20 seconds ago.");
    const text = [r.headline, ...r.details, r.updated].join(" ");
    expect(text).not.toMatch(/\bp95\b|\bDLQ\b|backlog|XLEN|Redis/i);
  });

  it("needs attention: low success rate, dead-lettered jobs, or no workers with work waiting", () => {
    const r = buildStatus({ ...base, sample: sample({ successRate: 0.82, dlqDepth: 3, workers: 0, queueDepth: 40 }), error: null });
    expect(r.state).toBe("attention");
    expect(r.headline).toBe("Relay is running, but needs attention.");
    expect(r.details.slice(0, 3)).toEqual([
      "No workers are running, and 40 jobs are waiting.",
      "Only 82% of recent jobs succeeded (target 90%).",
      "3 jobs failed after every retry and are waiting for an engineer to look at them.",
    ]);
  });

  it("reports jobs waiting for human review in words", () => {
    const r = buildStatus({ ...base, sample: sample({ reviewDepth: 1 }), error: null });
    expect(r.details).toContain("1 job is waiting for a person to review (a low-confidence classification, or a summary that didn't match its source).");
  });

  it("failure path, monitoring unavailable: says so and shows no numbers as if current", () => {
    const r = buildStatus({ ...base, sample: sample(), error: { at: new Date(NOW - 5000).toISOString(), errorClass: "MaxRetriesPerRequestError" } });
    expect(r.state).toBe("down");
    expect(r.headline).toBe("Relay can't reach its job queue right now.");
    expect(r.details.join(" ")).not.toMatch(/\d+%/);
  });

  it("failure path, status not updated: a sample older than 3 intervals is flagged as out of date", () => {
    const r = buildStatus({ ...base, sample: sample({ at: new Date(NOW - 5 * 60_000).toISOString() }), error: null });
    expect(r.state).toBe("unknown");
    expect(r.stale).toBe(true);
    expect(r.headline).toBe("Relay's status is out of date.");
    expect(r.updated).toMatch(/^These numbers are about 5 minutes old/);
  });

  it("no data yet: says so instead of inventing a success rate", () => {
    expect(buildStatus({ ...base, sample: null, error: null })).toMatchObject({ state: "unknown", headline: "Relay has just started." });
    const r = buildStatus({ ...base, sample: sample({ successRate: null, p95LatencyMs: null, windowJobs: 0 }), error: null });
    expect(r.details).toContain("No jobs have finished recently, so there is no success rate to show yet.");
    expect(r.details.join(" ")).not.toMatch(/100%/);
  });

  it("renders an escaped, self-refreshing page", () => {
    const html = renderStatusHtml({ state: "ok", headline: "<script>x</script>", details: ["a & b"], updated: "now", stale: false });
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain('http-equiv="refresh" content="30"');
    expect(html).not.toContain("<script>x");
  });
});

describe("JobOutcomeTracker: monitoring from what workers actually logged", () => {
  it("measures end-to-end latency from the stream id's enqueue time, and counts outcomes per interval", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.9 });
    const tracker = new JobOutcomeTracker(metrics, () => 1_000_000_000_250);
    tracker.observe({ event: "job_dequeued", correlationId: "c1", context: { jobId: "j1", messageId: "1000000000000-0" } });
    tracker.observe({ event: "job_processed", correlationId: "c1", context: { jobId: "j1" } });
    tracker.observe({ event: "job_dequeued", correlationId: "c2", context: { jobId: "j2", messageId: "1000000000100-0" } });
    tracker.observe({ event: "job_failed", correlationId: "c2", context: { jobId: "j2" } });
    tracker.observe({ event: "job_routed_to_review", correlationId: "c3", context: { jobId: "j3" } });
    tracker.observe({ event: "job_moved_to_dlq", correlationId: "c4", context: { jobId: "j4" } });
    tracker.observe({ event: "something_else", correlationId: "c5" });

    const snap = metrics.snapshot();
    expect(snap).toMatchObject({ totalRequests: 2, successCount: 1, failureCount: 1, successRate: 0.5 });
    expect(snap.recentSamples.map((s) => s.durationMs)).toEqual([250, 150]);
    expect(tracker.takeIntervalCounts()).toMatchObject({ processed: 1, failed: 1, routedToReview: 1, movedToDlq: 1 });
    expect(tracker.takeIntervalCounts()).toMatchObject({ processed: 0, failed: 0 });
  });

  it("rejects malformed stream ids instead of producing a nonsense latency", () => {
    expect(enqueuedAtMs("1729600000000-3")).toBe(1729600000000);
    expect(enqueuedAtMs("nope")).toBeNull();
    expect(enqueuedAtMs(undefined)).toBeNull();
  });
});
