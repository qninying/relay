// STORY-010 (REQ-014): turns the worker processes' structured log lines
// (which the pool already receives, see ProcessWorkerPool's onOutput) into
// job outcomes, so monitoring measures what the workers actually did rather
// than what something else claims they did.
//
// Latency is end to end: from when the job was enqueued (the Redis stream
// message id starts with the enqueue time in ms) to when a worker logged it
// processed. Feeds STORY-005's MetricsCollector for the rolling success rate
// and p95, and keeps per-interval counters for the sampler.

import type { MetricsCollector } from "./metrics.js";

export interface IntervalCounts {
  processed: number;
  failed: number;
  movedToDlq: number;
  routedToReview: number;
  skippedDuplicate: number;
  reclaimed: number;
}

const MAX_TRACKED = 10_000;

function emptyCounts(): IntervalCounts {
  return { processed: 0, failed: 0, movedToDlq: 0, routedToReview: 0, skippedDuplicate: 0, reclaimed: 0 };
}

// "1729600000000-0" -> 1729600000000. null if it doesn't look like a
// stream id, so a malformed line can't produce a nonsense latency.
export function enqueuedAtMs(messageId: unknown): number | null {
  if (typeof messageId !== "string") return null;
  const ms = Number(messageId.split("-")[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export class JobOutcomeTracker {
  private counts = emptyCounts();
  private readonly enqueuedAt = new Map<string, number>();

  constructor(
    private readonly metrics: MetricsCollector,
    private readonly now: () => number = Date.now
  ) {}

  observe(line: Record<string, unknown>): void {
    const context = (line.context ?? {}) as { jobId?: string; messageId?: string };
    const correlationId = typeof line.correlationId === "string" ? line.correlationId : "unknown";
    const jobId = context.jobId;

    switch (line.event) {
      case "job_dequeued": {
        const at = enqueuedAtMs(context.messageId);
        if (jobId && at !== null) {
          this.enqueuedAt.set(jobId, at);
          // Bounded: entries normally leave on completion; this only guards
          // against jobs that never complete in this process's lifetime.
          if (this.enqueuedAt.size > MAX_TRACKED) this.enqueuedAt.delete(this.enqueuedAt.keys().next().value!);
        }
        return;
      }
      case "job_processed":
        this.counts.processed += 1;
        this.metrics.record("success", this.latency(jobId), correlationId);
        return;
      case "job_failed":
        this.counts.failed += 1;
        this.metrics.record("failure", this.latency(jobId), correlationId);
        return;
      case "job_moved_to_dlq":
        this.counts.movedToDlq += 1;
        return;
      case "job_routed_to_review":
        this.counts.routedToReview += 1;
        return;
      case "job_skipped_duplicate":
        this.counts.skippedDuplicate += 1;
        if (jobId) this.enqueuedAt.delete(jobId);
        return;
      case "job_reclaimed":
        this.counts.reclaimed += 1;
        return;
    }
  }

  // Counts since the last call, then resets: one interval's worth.
  takeIntervalCounts(): IntervalCounts {
    const counts = this.counts;
    this.counts = emptyCounts();
    return counts;
  }

  // A worker always logs job_dequeued before job_processed, so an unknown
  // enqueue time only happens across a server restart mid-job. That rare case
  // records 0ms rather than dropping the outcome from the success rate.
  private latency(jobId: string | undefined): number {
    if (!jobId) return 0;
    const at = this.enqueuedAt.get(jobId);
    this.enqueuedAt.delete(jobId);
    return at === undefined ? 0 : Math.max(0, this.now() - at);
  }
}
