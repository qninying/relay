// STORY-106 (REQ-108): reading the review queue for the console. The queue
// is the review stream the workers write (STORY-007/103); this only reads
// it (XRANGE, oldest first), never consumes it. Entries leave the queue
// only through a decision (BatchResults.resolveReview).
//
// Entries come from batch items (STORY-103, decidable here) and from other
// jobs (STORY-007 low-confidence jobs, STORY-012 ungrounded summaries).
// Those have no batch result to update, so they're listed but not decidable
// in the console yet.

import type { Redis } from "ioredis";
import type { Job } from "../processJob.js";

export const MESSAGE_ID = /^\d{1,20}-\d{1,20}$/;

export interface ReviewItem {
  messageId: string;
  jobId: string;
  correlationId: string;
  reason: string;
  routedAt: string;
  confidence?: number;
  threshold?: number;
  // Batch items only.
  batch?: { batchId: string; row?: number; ref?: string; text: string; label: string; taxonomyId: string; taxonomyVersion: string };
}

export function toReviewItem(messageId: string, job: Job): ReviewItem {
  const p = (job.payload ?? {}) as Record<string, unknown>;
  const original = (p.originalPayload ?? {}) as Record<string, unknown>;
  const taxonomy = (p.taxonomy ?? {}) as Record<string, unknown>;
  const item: ReviewItem = {
    messageId,
    jobId: job.id,
    correlationId: job.correlationId,
    reason: typeof p.reason === "string" ? p.reason : "unknown",
    routedAt: typeof p.routedAt === "string" ? p.routedAt : "",
    confidence: typeof p.confidence === "number" ? p.confidence : undefined,
    threshold: typeof p.threshold === "number" ? p.threshold : undefined,
  };
  if (typeof p.batchId === "string" && typeof original.text === "string" && typeof p.label === "string" && typeof taxonomy.version === "string") {
    item.batch = {
      batchId: p.batchId,
      row: typeof original.row === "number" ? original.row : undefined,
      ref: typeof original.ref === "string" ? original.ref : undefined,
      text: original.text,
      label: p.label,
      taxonomyId: typeof taxonomy.id === "string" ? taxonomy.id : "",
      taxonomyVersion: taxonomy.version,
    };
  }
  return item;
}

function parse([messageId, fields]: [string, string[]]): ReviewItem {
  const i = fields.indexOf("data");
  return toReviewItem(messageId, JSON.parse(i === -1 ? "{}" : fields[i + 1]) as Job);
}

export class ReviewItems {
  constructor(
    private readonly redis: Redis,
    readonly stream: string
  ) {}

  // Oldest first, `limit` entries after `after` (exclusive), plus whether
  // there are more.
  async list(limit: number, after?: string): Promise<{ items: ReviewItem[]; more: boolean }> {
    const start = after && MESSAGE_ID.test(after) ? `(${after}` : "-";
    const raw = (await this.redis.xrange(this.stream, start, "+", "COUNT", limit + 1)) as [string, string[]][];
    return { items: raw.slice(0, limit).map(parse), more: raw.length > limit };
  }

  async get(messageId: string): Promise<ReviewItem | null> {
    if (!MESSAGE_ID.test(messageId)) return null;
    const raw = (await this.redis.xrange(this.stream, messageId, messageId)) as [string, string[]][];
    return raw.length ? parse(raw[0]) : null;
  }

  async count(): Promise<number> {
    return this.redis.xlen(this.stream);
  }
}
