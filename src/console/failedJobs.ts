// STORY-107 (REQ-110): failed jobs waiting for a person, for the console.
//
// Source: the dead-letter stream. STORY-008's automatic triage (dlqTriage.ts)
// runs only as a demo script, not in production, so in production every
// DLQ entry is a job nobody has dealt with yet. The store takes the stream
// as a parameter, so pointing it at a triage escalation stream later is a
// wiring change.
//
// Resubmit and discard are each one Lua step that checks the entry is still
// there, does the action, and removes the entry, so a job is resubmitted or
// discarded exactly once even if two engineers act at the same moment.
// - Resubmit re-enqueues the original job (same id, correlation ID and
//   idempotency key) on the work stream, in the same {data: json} shape
//   RedisStreamQueue.enqueue writes. If the job's original run actually
//   succeeded, its idempotency key is already claimed and the worker skips
//   it; the console also checks that key first and refuses, saying why.
// - Discard keeps a record (who, when, why, the job) on a capped discards
//   stream, besides the audit log.

import type { Redis } from "ioredis";
import type { Job } from "../processJob.js";
import { classifyReason, type FailureClass } from "../failureClassifier.js";
import { MESSAGE_ID } from "./reviewItems.js";

export interface FailedJob {
  messageId: string;
  jobId: string;
  correlationId: string;
  idempotencyKey: string;
  failureReason: string;
  failureClass: FailureClass;
  failedAt: string;
  // The job as it was originally submitted; absent if the entry lacks it.
  original?: Job;
}

export interface Discard {
  jobId: string;
  failureReason: string;
  by: string;
  note: string;
  at: string;
}

export type ResolveResult = "applied" | "gone";

const DISCARDS_KEPT = 10_000;

const RESUBMIT = `
if #redis.call('XRANGE', KEYS[1], ARGV[1], ARGV[1]) == 0 then return 'gone' end
redis.call('XADD', KEYS[2], '*', 'data', ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[1])
return 'applied'
`;

const DISCARD = `
if #redis.call('XRANGE', KEYS[1], ARGV[1], ARGV[1]) == 0 then return 'gone' end
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[3], '*', 'data', ARGV[2])
redis.call('XDEL', KEYS[1], ARGV[1])
return 'applied'
`;

function parse([messageId, fields]: [string, string[]]): FailedJob {
  const i = fields.indexOf("data");
  const entry = JSON.parse(i === -1 ? "{}" : fields[i + 1]) as Partial<Job>;
  const p = (entry.payload ?? {}) as { originalPayload?: unknown; failureReason?: unknown; failedAt?: unknown };
  const failureReason = typeof p.failureReason === "string" ? p.failureReason : "unknown";
  const job: FailedJob = {
    messageId,
    jobId: String(entry.id ?? "unknown"),
    correlationId: String(entry.correlationId ?? messageId),
    idempotencyKey: String(entry.idempotencyKey ?? ""),
    failureReason,
    failureClass: classifyReason(failureReason),
    failedAt: typeof p.failedAt === "string" ? p.failedAt : new Date(Number(messageId.split("-")[0])).toISOString(),
  };
  if (entry.id && entry.idempotencyKey && "originalPayload" in p) {
    job.original = { id: entry.id, correlationId: job.correlationId, idempotencyKey: entry.idempotencyKey, payload: p.originalPayload };
  }
  return job;
}

export class FailedJobs {
  constructor(
    private readonly redis: Redis,
    readonly stream: string,
    private readonly workStream: string,
    private readonly discardsStream: string,
    // Where workers record a job as done (RedisIdempotencyStore prefix).
    private readonly idemPrefix: string
  ) {}

  // Oldest first, `limit` after `after` (exclusive), plus whether there are more.
  async list(limit: number, after?: string): Promise<{ jobs: FailedJob[]; more: boolean }> {
    const start = after && MESSAGE_ID.test(after) ? `(${after}` : "-";
    const raw = (await this.redis.xrange(this.stream, start, "+", "COUNT", limit + 1)) as [string, string[]][];
    return { jobs: raw.slice(0, limit).map(parse), more: raw.length > limit };
  }

  async get(messageId: string): Promise<FailedJob | null> {
    if (!MESSAGE_ID.test(messageId)) return null;
    const raw = (await this.redis.xrange(this.stream, messageId, messageId)) as [string, string[]][];
    return raw.length ? parse(raw[0]) : null;
  }

  async count(): Promise<number> {
    return this.redis.xlen(this.stream);
  }

  // True if a worker has already completed a job with this key.
  async alreadyCompleted(idempotencyKey: string): Promise<boolean> {
    return idempotencyKey !== "" && (await this.redis.exists(this.idemPrefix + idempotencyKey)) === 1;
  }

  async resubmit(job: FailedJob): Promise<ResolveResult> {
    if (!job.original) throw new Error("resubmit: entry has no original job");
    return (await this.redis.eval(RESUBMIT, 2, this.stream, this.workStream, job.messageId, JSON.stringify(job.original))) as ResolveResult;
  }

  async discard(job: FailedJob, by: string, note: string, at = new Date()): Promise<ResolveResult> {
    const record = { jobId: job.jobId, failureReason: job.failureReason, by, note, at: at.toISOString(), job: job.original ?? null };
    return (await this.redis.eval(DISCARD, 2, this.stream, this.discardsStream, job.messageId, JSON.stringify(record), String(DISCARDS_KEPT))) as ResolveResult;
  }

  // Newest first.
  async recentDiscards(limit: number): Promise<Discard[]> {
    const raw = (await this.redis.xrevrange(this.discardsStream, "+", "-", "COUNT", limit)) as [string, string[]][];
    return raw.map(([, fields]) => JSON.parse(fields[fields.indexOf("data") + 1]) as Discard);
  }
}
