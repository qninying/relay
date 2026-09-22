// STORY-002: process jobs using a durable queue. Covers REQ-001 (Redis Streams
// or SQS as the durable queue — this uses Redis Streams) and REQ-011 (log
// low-confidence classifications with their correlation ID). A consumer group
// is used so XACK gives an explicit, durable "this message was handled"
// signal — an unacked message stays claimable by another consumer rather than
// silently vanishing if a worker dies mid-processing.
//
// Deliberately minimal: dequeueOne() reads and acks a single message. A
// standing consumer loop with graceful shutdown and multiple worker processes
// is STORY-006 (autoscaling), not this story.

import type { Redis } from "ioredis";
import { logJson } from "./logger.js";
import type { Job } from "./processJob.js";

// REQ-011's own wording is "low-confidence," not a specific number — 0.5 is a
// placeholder threshold to satisfy this story's logging requirement. The real
// tuned value is a product decision for whoever owns the classification
// taxonomy (REQ-017, STORY-011), not decided here.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export interface EnqueueResult {
  messageId: string;
}

export class RedisStreamQueue {
  constructor(
    private readonly redis: Redis,
    private readonly streamKey: string,
    private readonly groupName: string
  ) {}

  // Idempotent: BUSYGROUP means the group already exists, which is the normal
  // case on every call after the first — not a failure.
  async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", this.streamKey, this.groupName, "0", "MKSTREAM");
    } catch (error) {
      if (error instanceof Error && error.message.includes("BUSYGROUP")) {
        return;
      }
      throw error;
    }
  }

  async enqueue(job: Job): Promise<EnqueueResult> {
    try {
      const messageId = await this.redis.xadd(this.streamKey, "*", "data", JSON.stringify(job));
      if (!messageId) {
        throw new Error("XADD returned no message id");
      }
      return { messageId };
    } catch (error) {
      const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
      logJson("error", {
        event: "job_enqueue_failed",
        correlationId: job.correlationId,
        outcome: "failure",
        errorClass,
        context: { jobId: job.id },
      });
      throw error;
    }
  }

  // Returns null when there's nothing to read — not an error, just an empty
  // queue at this instant.
  async dequeueOne(consumerName: string): Promise<Job | null> {
    const response = await this.redis.xreadgroup(
      "GROUP",
      this.groupName,
      consumerName,
      "COUNT",
      1,
      "STREAMS",
      this.streamKey,
      ">"
    );
    if (!response) {
      return null;
    }

    const [[, messages]] = response as [string, [string, string[]][]][];
    if (!messages || messages.length === 0) {
      return null;
    }

    const [messageId, fields] = messages[0];
    const dataIndex = fields.indexOf("data");
    if (dataIndex === -1) {
      throw new Error(`Stream message ${messageId} has no "data" field`);
    }
    const job = JSON.parse(fields[dataIndex + 1]) as Job;

    if (typeof job.confidence === "number" && job.confidence < LOW_CONFIDENCE_THRESHOLD) {
      logJson("info", {
        event: "job_low_confidence",
        correlationId: job.correlationId,
        outcome: "skipped",
        context: { jobId: job.id, confidence: job.confidence },
      });
    }

    logJson("info", {
      event: "job_dequeued",
      correlationId: job.correlationId,
      context: { jobId: job.id, messageId },
    });

    // Ack after the job is handed back to the caller, not before — an ack
    // here just means "delivered," matching this story's minimal scope. A
    // caller that wants ack-after-processing (so a crash mid-handling leaves
    // the message claimable again) composes that itself; DLQ/retry semantics
    // are REQ-004/REQ-015, STORY-004/STORY-008.
    await this.redis.xack(this.streamKey, this.groupName, messageId);

    return job;
  }
}
