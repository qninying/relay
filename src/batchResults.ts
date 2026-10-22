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
//
// STORY-106: a review decision changes a "review" item to "done" (approved
// or corrected) or "rejected", and removes its review-queue entry, in one
// atomic step (resolveReview), so a decision is applied exactly once and
// an item is never left decided but still queued, or dequeued but undecided.

import type { Redis } from "ioredis";
import type { Job } from "./processJob.js";
import { checkOutputContractGuardrail, type JobOutputSchema } from "../guardrails/outputContractGuardrail.js";
import { logJson } from "./logger.js";
import { DAY_MS, DEFAULT_BATCH_RETENTION_DAYS } from "./batchRetention.js";

export type ItemStatus = "done" | "review" | "failed" | "rejected";
export type ReviewDecision = "approved" | "corrected" | "rejected";

export interface ItemOutcome {
  status: ItemStatus;
  label?: string;
  confidence?: number;
  taxonomyVersion?: string;
  reason?: string;
  at: string;
  // Set by a review decision (STORY-106).
  reviewedBy?: string;
  reviewDecision?: ReviewDecision;
  note?: string;
  // On a correction: what the model said, and its taxonomy version if the
  // taxonomy has changed since.
  modelLabel?: string;
  modelTaxonomyVersion?: string;
}

// What resolveReview did: applied, or why nothing was decided.
//   gone           the review entry is no longer queued (already decided)
//   batch_deleted  the batch expired (retention); the stale entry is removed
//   not_waiting    the item isn't waiting for review; the stale entry is removed
export type ResolveOutcome = "applied" | "gone" | "batch_deleted" | "not_waiting";

export interface BatchCounts {
  done: number;
  review: number;
  failed: number;
  rejected: number;
  recorded: number;
}

const REVIEW_FIELDS = ["reviewedBy", "reviewDecision", "note", "modelLabel", "modelTaxonomyVersion"];

export const OUTCOME_SCHEMAS: Record<ItemStatus, JobOutputSchema> = {
  done: { jobType: "batch_item_done", requiredFields: ["status", "label", "confidence", "taxonomyVersion", "at"], allowedFields: new Set(["status", "label", "confidence", "taxonomyVersion", "at", ...REVIEW_FIELDS]) },
  review: { jobType: "batch_item_review", requiredFields: ["status", "label", "confidence", "taxonomyVersion", "at"], allowedFields: new Set(["status", "label", "confidence", "taxonomyVersion", "at"]) },
  failed: { jobType: "batch_item_failed", requiredFields: ["status", "reason", "at"], allowedFields: new Set(["status", "reason", "taxonomyVersion", "at"]) },
  rejected: {
    jobType: "batch_item_rejected",
    requiredFields: ["status", "label", "confidence", "taxonomyVersion", "at", "reviewedBy", "reviewDecision", "note"],
    allowedFields: new Set(["status", "label", "confidence", "taxonomyVersion", "at", "reviewedBy", "reviewDecision", "note"]),
  },
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
  for (const key of ["label", "reason", "taxonomyVersion", "reviewedBy", "note", "modelLabel", "modelTaxonomyVersion"]) if (key in record && typeof record[key] !== "string") violations.push(`BAD_${key.toUpperCase()}`);
  if ("reviewDecision" in record) {
    const expected = outcome.status === "rejected" ? ["rejected"] : ["approved", "corrected"];
    if (!expected.includes(String(record.reviewDecision))) violations.push("BAD_REVIEW_DECISION");
  }
  if (outcome.status === "done" && ("reviewDecision" in record) !== ("reviewedBy" in record)) violations.push("INCOMPLETE_REVIEW");
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

// Checks first, writes last: Redis doesn't roll back a script that errors,
// so nothing is written unless every check passed.
const RESOLVE_REVIEW = `
if #redis.call('XRANGE', KEYS[1], ARGV[1], ARGV[1]) == 0 then return 'gone' end
local current = redis.call('HGET', KEYS[2], ARGV[2])
if not current then redis.call('XDEL', KEYS[1], ARGV[1]) return 'batch_deleted' end
if cjson.decode(current).status ~= 'review' then redis.call('XDEL', KEYS[1], ARGV[1]) return 'not_waiting' end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('XDEL', KEYS[1], ARGV[1])
return 'applied'
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

  // STORY-106: applies a review decision to a "review" item and removes its
  // review entry (reviewStream, messageId), atomically. The outcome passes
  // the same contract check as any other before anything is touched.
  async resolveReview(batchId: string, jobId: string, reviewStream: string, messageId: string, outcome: ItemOutcome): Promise<ResolveOutcome> {
    if (outcome.status !== "done" && outcome.status !== "rejected") throw new OutputContractViolation(["NOT_A_DECISION"]);
    const violations = checkOutcome(outcome);
    if (violations.length) throw new OutputContractViolation(violations);
    return (await this.redis.eval(RESOLVE_REVIEW, 2, reviewStream, this.itemsKey(batchId), messageId, jobId, JSON.stringify(outcome))) as ResolveOutcome;
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
    const counts: BatchCounts = { done: 0, review: 0, failed: 0, rejected: 0, recorded: 0 };
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
