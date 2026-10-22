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
import { isLowConfidence, reviewThresholdFor } from "./confidence.js";

export class BacklogUnknownError extends Error {}

export interface Delivery {
  job: Job;
  messageId: string;
  // How many times this message has been handed to a consumer (1 = first).
  deliveryCount: number;
}

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

  // STORY-006: how many entries this group has not yet been delivered, i.e.
  // the queue depth the autoscaler scales on. Uses the consumer group's own
  // `lag` (Redis 7+), not XLEN, since XLEN also counts entries that were
  // already delivered. Redis reports lag as nil when it can't compute it (for
  // example after XDEL in the undelivered range). That throws rather than
  // returning 0, because a fabricated 0 would make the autoscaler scale down
  // a backlog it simply can't see.
  async getBacklog(): Promise<number> {
    const groups = (await this.redis.xinfo("GROUPS", this.streamKey)) as unknown[][];
    for (const group of groups) {
      const fields = new Map<string, unknown>();
      for (let i = 0; i < group.length; i += 2) fields.set(String(group[i]), group[i + 1]);
      if (fields.get("name") !== this.groupName) continue;
      const lag = fields.get("lag");
      if (typeof lag !== "number") {
        throw new BacklogUnknownError(`Redis could not compute lag for group ${this.groupName}`);
      }
      return lag;
    }
    throw new BacklogUnknownError(`Consumer group ${this.groupName} does not exist on ${this.streamKey}`);
  }

  // STORY-007: read entries without consuming them (XRANGE, oldest first),
  // so an operator or the MCP server can see what's waiting for review
  // without taking it off the queue.
  async peek(count: number): Promise<Job[]> {
    const entries = (await this.redis.xrange(this.streamKey, "-", "+", "COUNT", count)) as [string, string[]][];
    return entries.map(([messageId, fields]) => {
      const dataIndex = fields.indexOf("data");
      if (dataIndex === -1) throw new Error(`Stream message ${messageId} has no "data" field`);
      return JSON.parse(fields[dataIndex + 1]) as Job;
    });
  }

  // Returns null when there's nothing to read — not an error, just an empty
  // queue at this instant.
  async dequeueOne(consumerName: string): Promise<Job | null> {
    const delivery = await this.readNew(consumerName);
    if (!delivery) return null;
    // Acks on delivery: used where losing a message to a crash mid-handling
    // is acceptable (DLQ triage reads, tests). Workers use readNew() + ack()
    // instead, acking only after processing (STORY-009).
    await this.ack(delivery.messageId);
    return delivery.job;
  }

  // STORY-009: read one new message WITHOUT acking it. It stays in the
  // group's pending list until ack() is called, so if this worker dies
  // mid-job another worker can reclaim it (reclaimStale) instead of it being
  // lost. Returns null when there's nothing new.
  async readNew(consumerName: string): Promise<Delivery | null> {
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
    return { job: this.parse(messageId, fields), messageId, deliveryCount: 1 };
  }

  async ack(messageId: string): Promise<void> {
    await this.redis.xack(this.streamKey, this.groupName, messageId);
  }

  // STORY-009: take over messages another consumer read but never acked
  // within minIdleMs, which is what a worker killed mid-job leaves behind
  // (XAUTOCLAIM). minIdleMs must be longer than any real job takes, or a
  // slow-but-alive worker's job gets processed twice (the durable
  // idempotency claim still stops a duplicate, but the work is wasted).
  // deliveryCount comes from XPENDING so a message that keeps killing
  // workers can be dead-lettered rather than retried forever.
  async reclaimStale(consumerName: string, minIdleMs: number, count = 10): Promise<Delivery[]> {
    const response = (await this.redis.xautoclaim(this.streamKey, this.groupName, consumerName, minIdleMs, "0-0", "COUNT", count)) as [
      string,
      Array<[string, string[]] | null>,
      string[]?,
    ];
    const claimed = (response?.[1] ?? []).filter((entry): entry is [string, string[]] => Array.isArray(entry) && Array.isArray(entry[1]));
    const deliveries: Delivery[] = [];
    for (const [messageId, fields] of claimed) {
      const pending = (await this.redis.xpending(this.streamKey, this.groupName, messageId, messageId, 1)) as Array<[string, string, number, number]>;
      const deliveryCount = pending[0]?.[3] ?? 1;
      const job = this.parse(messageId, fields);
      logJson("warn", {
        event: "job_reclaimed",
        correlationId: job.correlationId,
        context: { jobId: job.id, messageId, consumer: consumerName, deliveryCount, minIdleMs },
      });
      deliveries.push({ job, messageId, deliveryCount });
    }
    return deliveries;
  }

  private parse(messageId: string, fields: string[]): Job {
    const dataIndex = fields.indexOf("data");
    if (dataIndex === -1) {
      throw new Error(`Stream message ${messageId} has no "data" field`);
    }
    const job = JSON.parse(fields[dataIndex + 1]) as Job;

    if (isLowConfidence(job)) {
      logJson("info", {
        event: "job_low_confidence",
        correlationId: job.correlationId,
        outcome: "skipped",
        context: { jobId: job.id, confidence: job.confidence, threshold: reviewThresholdFor(job) },
      });
    }

    logJson("info", {
      event: "job_dequeued",
      correlationId: job.correlationId,
      context: { jobId: job.id, messageId },
    });
    return job;
  }
}
