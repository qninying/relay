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
//
// Retention (batchRetention.ts): the items hash expires with its batch
// record, so a batch's results never outlive it. An item for a batch with
// no record (expired, or a batch not made in the console) gets the default
// retention instead, so nothing is kept forever.
//
// REQ-012: every outcome is validated against the declared schema for its
// status (guardrails/outputContractGuardrail.ts, the same check STORY-003
// applies to external API output) before it is persisted. An off-contract
// outcome (missing or unexpected fields, or text that trips the injection
// check) is refused with OutputContractViolation and nothing is written.

import type { Redis } from "ioredis";
import type { Job } from "./processJob.js";
import { checkOutputContractGuardrail, type JobOutputSchema } from "../guardrails/outputContractGuardrail.js";
import { logJson } from "./logger.js";
import { DAY_MS, DEFAULT_BATCH_RETENTION_DAYS } from "./batchRetention.js";

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

export const OUTCOME_SCHEMAS: Record<ItemStatus, JobOutputSchema> = {
  done: { jobType: "batch_item_done", requiredFields: ["status", "label", "confidence", "taxonomyVersion", "at"], allowedFields: new Set(["status", "label", "confidence", "taxonomyVersion", "at"]) },
  review: { jobType: "batch_item_review", requiredFields: ["status", "label", "confidence", "taxonomyVersion", "at"], allowedFields: new Set(["status", "label", "confidence", "taxonomyVersion", "at"]) },
  failed: { jobType: "batch_item_failed", requiredFields: ["status", "reason", "at"], allowedFields: new Set(["status", "reason", "taxonomyVersion", "at"]) },
};

export class OutputContractViolation extends Error {
  constructor(readonly violations: string[]) {
    super(`Batch item outcome failed its output contract: ${violations.join(", ")}`);
  }
}

// Schema check plus the type checks a field list can't express.
export function checkOutcome(outcome: ItemOutcome): string[] {
  const schema = OUTCOME_SCHEMAS[outcome.status];
  if (!schema) return ["UNKNOWN_STATUS"];
  const record = Object.fromEntries(Object.entries(outcome).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
  const violations: string[] = [...checkOutputContractGuardrail(record, schema).violations];
  if ("confidence" in record && (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1)) violations.push("BAD_CONFIDENCE");
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) violations.push("BAD_TIMESTAMP");
  for (const key of ["label", "reason", "taxonomyVersion"]) if (key in record && typeof record[key] !== "string") violations.push(`BAD_${key.toUpperCase()}`);
  return violations;
}

const RECORD_ONCE = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
local ttl = redis.call('PTTL', KEYS[3])
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl)
elseif ttl == -2 then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
if ARGV[3] ~= '' then redis.call('XADD', KEYS[2], '*', 'data', ARGV[3]) end
return 1
`;

export class BatchResults {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:batch:",
    private readonly retentionDays = DEFAULT_BATCH_RETENTION_DAYS
  ) {}

  itemsKey(batchId: string): string {
    return `${this.prefix}${batchId}:items`;
  }

  // Returns true if this call recorded the outcome, false if the item
  // already had one (a redelivery). reviewEntry is enqueued on reviewStream
  // only when the outcome is recorded.
  async record(batchId: string, jobId: string, outcome: ItemOutcome, review?: { stream: string; entry: Job }): Promise<boolean> {
    const violations = checkOutcome(outcome);
    if (violations.length) {
      logJson("error", {
        event: "output_validation_failed",
        correlationId: review?.entry.correlationId ?? jobId,
        outcome: "failure",
        errorClass: "OutputContractViolation",
        context: { batchId, jobId, status: outcome.status, violations },
      });
      throw new OutputContractViolation(violations);
    }
    const result = await this.redis.eval(
      RECORD_ONCE,
      3,
      this.itemsKey(batchId),
      review?.stream ?? `${this.prefix}unused`,
      `${this.prefix}${batchId}:meta`,
      jobId,
      JSON.stringify(outcome),
      review ? JSON.stringify(review.entry) : "",
      String(this.retentionDays * DAY_MS)
    );
    return result === 1;
  }

  async get(batchId: string, jobId: string): Promise<ItemOutcome | null> {
    const raw = await this.redis.hget(this.itemsKey(batchId), jobId);
    return raw ? (JSON.parse(raw) as ItemOutcome) : null;
  }

  // Outcomes for several items in one round trip, in the order asked
  // (null where an item has no result yet). STORY-105's item list and export.
  async getMany(batchId: string, jobIds: string[]): Promise<Array<ItemOutcome | null>> {
    if (jobIds.length === 0) return [];
    const raw = await this.redis.hmget(this.itemsKey(batchId), ...jobIds);
    return raw.map((r) => (r ? (JSON.parse(r) as ItemOutcome) : null));
  }

  async counts(batchId: string): Promise<BatchCounts> {
    const counts: BatchCounts = { done: 0, review: 0, failed: 0, recorded: 0 };
    // HSCAN may return a field more than once (while Redis rehashes a large
    // hash), so each item is counted by its id, once (STORY-105 trust).
    const seen = new Set<string>();
    let cursor = "0";
    do {
      const [next, flat] = await this.redis.hscan(this.itemsKey(batchId), cursor, "COUNT", 500);
      cursor = next;
      for (let i = 0; i < flat.length; i += 2) {
        if (seen.has(flat[i])) continue;
        seen.add(flat[i]);
        const status = (JSON.parse(flat[i + 1]) as ItemOutcome).status;
        counts[status] += 1;
        counts.recorded += 1;
      }
    } while (cursor !== "0");
    return counts;
  }
}
