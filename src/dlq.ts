// STORY-004: dead-letter queue for jobs that exhaust retries (REQ-004).
// Reuses RedisStreamQueue (STORY-002) pointed at a separate DLQ stream — a
// dead-letter queue is just another durable stream a job lands in instead of
// vanishing, not a new queue mechanism.

import type { RedisStreamQueue } from "./queue.js";
import { logJson } from "./logger.js";
import type { Job } from "./processJob.js";

// The original job is preserved whole inside payload, alongside why it died
// and when — nothing about the original job is discarded or reshaped.
function buildDlqEntry(job: Job, failureReason: string): Job {
  return {
    id: job.id,
    correlationId: job.correlationId,
    idempotencyKey: job.idempotencyKey,
    payload: { originalPayload: job.payload, failureReason, failedAt: new Date().toISOString() },
  };
}

export async function moveToDeadLetterQueue(
  dlq: RedisStreamQueue,
  job: Job,
  failureReason: string
): Promise<void> {
  await dlq.enqueue(buildDlqEntry(job, failureReason));
  logJson("warn", {
    event: "job_moved_to_dlq",
    correlationId: job.correlationId,
    outcome: "failure",
    context: { jobId: job.id, failureReason },
  });
}

export interface TriageResult {
  jobId: string;
  failureReason: string;
}

// dlq.dequeueOne() already logs job_dequeued with the correlation ID
// (RedisStreamQueue's own behavior, reused as-is here) — this adds the
// DLQ-specific job_triaged log, carrying the reason forward from why the
// job died in the first place. See docs/runbooks/DLQ_TRIAGE.md for what a
// human does with this.
export async function triageNextDeadLetterEntry(
  dlq: RedisStreamQueue,
  consumerName: string
): Promise<TriageResult | null> {
  const entry = await dlq.dequeueOne(consumerName);
  if (!entry) {
    return null;
  }

  const payload = entry.payload as { failureReason?: string } | null;
  const failureReason = payload?.failureReason ?? "unknown";

  logJson("warn", {
    event: "job_triaged",
    correlationId: entry.correlationId,
    outcome: "failure",
    context: { jobId: entry.id, failureReason },
  });

  return { jobId: entry.id, failureReason };
}
