// STORY-103 (REQ-115): per-batch item results in Redis. One hash per batch,
// one field per job id, value = the item's outcome as JSON.
//
// Write-once, atomically: a Lua script sets the field only if it's empty
// (HSETNX) and, for an item that needs review, adds its review-queue entry
// in the same step. So a redelivered job (STORY-009) can never overwrite a
// result, count twice, or put a second copy in the review queue; and a crash
// can't leave an item marked "review" with nothing in the review queue.
//
// Counts are derived from the stored outcomes, never kept as separate
// counters, so they can't drift from the items.

import type { Redis } from "ioredis";
import type { Job } from "./processJob.js";

export type ItemStatus = "done" | "review" | "failed";

export interface ItemOutcome {
  status: ItemStatus;
  label?: string;
  confidence?: number;
  taxonomyVersion?: string;
  reason?: string;
  at: string;
}

export interface BatchCounts {
  done: number;
  review: number;
  failed: number;
  recorded: number;
}

const RECORD_ONCE = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
if ARGV[3] ~= '' then redis.call('XADD', KEYS[2], '*', 'data', ARGV[3]) end
return 1
`;

export class BatchResults {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:batch:"
  ) {}

  itemsKey(batchId: string): string {
    return `${this.prefix}${batchId}:items`;
  }

  // Returns true if this call recorded the outcome, false if the item
  // already had one (a redelivery). reviewEntry is enqueued on reviewStream
  // only when the outcome is recorded.
  async record(batchId: string, jobId: string, outcome: ItemOutcome, review?: { stream: string; entry: Job }): Promise<boolean> {
    const result = await this.redis.eval(
      RECORD_ONCE,
      2,
      this.itemsKey(batchId),
      review?.stream ?? `${this.prefix}unused`,
      jobId,
      JSON.stringify(outcome),
      review ? JSON.stringify(review.entry) : ""
    );
    return result === 1;
  }

  async get(batchId: string, jobId: string): Promise<ItemOutcome | null> {
    const raw = await this.redis.hget(this.itemsKey(batchId), jobId);
    return raw ? (JSON.parse(raw) as ItemOutcome) : null;
  }

  async counts(batchId: string): Promise<BatchCounts> {
    const counts: BatchCounts = { done: 0, review: 0, failed: 0, recorded: 0 };
    let cursor = "0";
    do {
      const [next, flat] = await this.redis.hscan(this.itemsKey(batchId), cursor, "COUNT", 500);
      cursor = next;
      for (let i = 1; i < flat.length; i += 2) {
        const status = (JSON.parse(flat[i]) as ItemOutcome).status;
        counts[status] += 1;
        counts.recorded += 1;
      }
    } while (cursor !== "0");
    return counts;
  }
}
