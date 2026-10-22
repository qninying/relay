// STORY-010 (REQ-014): records Relay's health over time. Every interval it
// takes one sample (success rate, p95 job latency, jobs processed/failed,
// DLQ additions and depth, review routing, queue depth, workers, circuit
// breaker trips) and appends it to a capped Redis stream, so the history
// survives a restart of the app and a deploy.
//
// Each sample is also logged as metrics_sample with its own correlation ID
// (the trust criterion: monitoring data logged for auditability), and the
// stream entry carries the same ID so a sample can be matched to its log
// line.
//
// Failure path (monitoring unavailable): if Redis can't be read or written,
// the sample is logged as monitoring_sample_failed and lastError is set; the
// status view reports "monitoring unavailable" instead of showing stale
// numbers as current. The next interval tries again.
//
// Circuit breaker trips are recorded as null: the worker path makes no
// external API calls yet, so there is no breaker in it to trip. A real 0
// would claim something was measured.

import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { logJson } from "./logger.js";
import type { MetricsCollector } from "./metrics.js";
import type { RedisStreamQueue } from "./queue.js";
import type { JobOutcomeTracker } from "./jobOutcomeTracker.js";

export interface MetricsSample {
  sampleId: string;
  at: string;
  intervalMs: number;
  successRate: number | null;
  p95LatencyMs: number | null;
  windowJobs: number;
  processed: number;
  failed: number;
  movedToDlq: number;
  dlqDepth: number;
  routedToReview: number;
  reviewDepth: number;
  queueDepth: number;
  pending: number;
  workers: number;
  breakerTrips: number | null;
}

export interface SamplerDeps {
  redis: Redis;
  queue: RedisStreamQueue;
  queueStream: string;
  queueGroup: string;
  dlqStream: string;
  reviewStream: string;
  metrics: MetricsCollector;
  tracker: JobOutcomeTracker;
  workerCount: () => number;
  historyKey?: string;
  // ~7 days at one sample a minute.
  maxSamples?: number;
}

export class MonitoringSampler {
  private timer: NodeJS.Timeout | undefined;
  private last: MetricsSample | null = null;
  private lastError: { at: string; errorClass: string } | null = null;
  private lastAt = Date.now();

  constructor(private readonly deps: SamplerDeps) {}

  get historyKey(): string {
    return this.deps.historyKey ?? "relay:metrics";
  }

  latest(): { sample: MetricsSample | null; error: { at: string; errorClass: string } | null } {
    return { sample: this.last, error: this.lastError };
  }

  async sampleOnce(): Promise<MetricsSample | null> {
    const sampleId = randomUUID();
    const now = Date.now();
    const intervalMs = now - this.lastAt;
    this.lastAt = now;
    const counts = this.deps.tracker.takeIntervalCounts();
    const slo = this.deps.metrics.snapshot();
    try {
      const { redis } = this.deps;
      const [queueDepth, pendingSummary, dlqDepth, reviewDepth] = await Promise.all([
        this.deps.queue.getBacklog(),
        redis.xpending(this.deps.queueStream, this.deps.queueGroup) as Promise<[number, ...unknown[]]>,
        redis.xlen(this.deps.dlqStream),
        redis.xlen(this.deps.reviewStream),
      ]);
      const sample: MetricsSample = {
        sampleId,
        at: new Date(now).toISOString(),
        intervalMs,
        successRate: slo.successRate,
        p95LatencyMs: slo.p95LatencyMs,
        windowJobs: slo.totalRequests,
        processed: counts.processed,
        failed: counts.failed,
        movedToDlq: counts.movedToDlq,
        dlqDepth,
        routedToReview: counts.routedToReview,
        reviewDepth,
        queueDepth,
        pending: Number(pendingSummary[0] ?? 0),
        workers: this.deps.workerCount(),
        breakerTrips: null,
      };
      await redis.xadd(this.historyKey, "MAXLEN", "~", String(this.deps.maxSamples ?? 10_080), "*", "sample", JSON.stringify(sample));
      this.last = sample;
      this.lastError = null;
      logJson("info", { event: "metrics_sample", correlationId: sampleId, outcome: "success", context: { ...sample } });
      return sample;
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
      this.lastError = { at: new Date(now).toISOString(), errorClass };
      logJson("error", {
        event: "monitoring_sample_failed",
        correlationId: sampleId,
        outcome: "failure",
        errorClass,
        context: { processedThisInterval: counts.processed, failedThisInterval: counts.failed },
      });
      return null;
    }
  }

  async history(sinceMs: number, limit = 2000): Promise<MetricsSample[]> {
    const entries = (await this.deps.redis.xrange(this.historyKey, String(sinceMs), "+", "COUNT", limit)) as [string, string[]][];
    return entries.map(([, fields]) => JSON.parse(fields[fields.indexOf("sample") + 1]) as MetricsSample);
  }

  // Self-scheduling (no overlap if a sample is slow).
  start(intervalMs: number): void {
    const tick = async () => {
      await this.sampleOnce();
      this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
