// STORY-005: SLO metrics — success rate, p95 latency, and a real error budget
// against a target SLO, updated live as jobs are actually processed (REQ-006,
// REQ-018). A rolling, count-based window, not an all-time average — an
// all-time average would hide a currently-unhealthy system behind a long
// healthy history, which is exactly the "metrics are inaccurate" failure
// path this story has to handle.

import { logJson } from "./logger.js";

export type JobOutcome = "success" | "failure";

export interface MetricsRecord {
  outcome: JobOutcome;
  durationMs: number;
}

export interface ErrorBudget {
  targetSuccessRate: number;
  allowedFailures: number;
  actualFailures: number;
  remaining: number;
  breached: boolean;
}

export interface SloSnapshot {
  windowSize: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  // null, not 0 or 1, when nothing has been recorded yet — a 0% or 100%
  // success rate with zero data behind it would be an invented number, not
  // a measured one.
  successRate: number | null;
  p95LatencyMs: number | null;
  errorBudget: ErrorBudget;
  // Real, chronological, most-recent-last — for a genuine recent-activity
  // trend. Deliberately NOT a 24h/7d/30d time series: nothing persists
  // metrics across a restart, so a longer time range would have no real
  // data behind it. This is the honest alternative — what's actually in
  // the current rolling window, nothing invented to fill a wider range.
  recentSamples: MetricsRecord[];
}

export interface MetricsCollectorOptions {
  windowSize: number;
  targetSuccessRate: number;
}

function nearestRankPercentile(sortedValues: number[], p: number): number {
  const index = Math.min(Math.max(Math.ceil(p * sortedValues.length) - 1, 0), sortedValues.length - 1);
  return sortedValues[index];
}

export class MetricsCollector {
  private readonly records: MetricsRecord[] = [];

  constructor(private readonly options: MetricsCollectorOptions) {}

  // Updates the in-memory window synchronously — "live" means the very next
  // snapshot() reflects this call, not a batched or delayed one.
  record(outcome: JobOutcome, durationMs: number, correlationId: string): void {
    this.records.push({ outcome, durationMs });
    if (this.records.length > this.options.windowSize) {
      this.records.shift();
    }

    const snapshot = this.snapshot();
    logJson("info", {
      event: "slo_metric_recorded",
      correlationId,
      outcome,
      durationMs,
      context: {
        successRate: snapshot.successRate,
        errorBudgetRemaining: snapshot.errorBudget.remaining,
        errorBudgetBreached: snapshot.errorBudget.breached,
      },
    });
  }

  snapshot(): SloSnapshot {
    const total = this.records.length;
    const successCount = this.records.filter((r) => r.outcome === "success").length;
    const failureCount = total - successCount;
    const successRate = total === 0 ? null : successCount / total;

    const sortedDurations = this.records.map((r) => r.durationMs).sort((a, b) => a - b);
    const p95LatencyMs = sortedDurations.length === 0 ? null : nearestRankPercentile(sortedDurations, 0.95);

    const allowedFailures = total * (1 - this.options.targetSuccessRate);
    const remaining = allowedFailures - failureCount;

    return {
      windowSize: this.options.windowSize,
      totalRequests: total,
      successCount,
      failureCount,
      successRate,
      p95LatencyMs,
      errorBudget: {
        targetSuccessRate: this.options.targetSuccessRate,
        allowedFailures,
        actualFailures: failureCount,
        remaining,
        breached: remaining < 0,
      },
      recentSamples: this.records.slice(-20),
    };
  }
}
