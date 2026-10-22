// STORY-104 (REQ-106, REQ-105): batch drafts and submission.
//
// Preview: the validated rows are saved as a draft (1 hour, owned by one
// operator) with the batch id already chosen. Submit: enqueues the draft's
// rows as batch-item jobs (STORY-103 classifies them).
//
// Submission is idempotent end to end, beyond the per-form key ActionRunner
// already enforces:
// - the batch id is fixed at preview time, so two tabs submitting the same
//   draft target the same batch;
// - each row's job uses idempotency key "<batchId>-<row>";
// - the batch record keeps how many rows have been queued, and submit
//   resumes from there. If Redis fails partway (e.g. it's full, noeviction),
//   the failure is reported, nothing already queued is queued again on retry,
//   and the batch is marked submitted only when every row is queued.

import type { Redis } from "ioredis";
import { randomBytes, randomUUID } from "node:crypto";
import type { RedisStreamQueue } from "../queue.js";
import type { CsvRow, RowError } from "./csv.js";
import { logJson } from "../logger.js";

export const DRAFT_TTL_SECONDS = 60 * 60;

export interface Draft {
  draftId: string;
  batchId: string;
  operator: string;
  filename: string;
  rows: CsvRow[];
  errors: RowError[];
  totalRows: number;
  createdAt: string;
}

export interface BatchMeta {
  batchId: string;
  operator: string;
  filename: string;
  total: number;
  queued: number;
  status: "submitting" | "submitted";
  createdAt: string;
  submittedAt?: string;
}

export class BatchSubmitError extends Error {
  constructor(
    readonly queued: number,
    readonly total: number,
    cause: unknown
  ) {
    super(`Queued ${queued} of ${total} rows before the queue refused more`);
    this.cause = cause;
  }
}

// Another submit of the same batch is running right now (e.g. two tabs).
export class BatchBusyError extends Error {}

const SUBMIT_LOCK_SECONDS = 300;

export class BatchStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "relay:console:"
  ) {}

  private draftKey(operator: string, draftId: string): string {
    return `${this.prefix}draft:${operator}:${draftId}`;
  }
  private metaKey(batchId: string): string {
    return `relay:batch:${batchId}:meta`;
  }
  private indexKey(): string {
    return `${this.prefix}batches`;
  }

  async createDraft(operator: string, filename: string, rows: CsvRow[], errors: RowError[], totalRows: number): Promise<Draft> {
    const draft: Draft = {
      draftId: randomBytes(16).toString("hex"),
      batchId: `b${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
      operator,
      filename: filename.slice(0, 200),
      rows,
      errors,
      totalRows,
      createdAt: new Date().toISOString(),
    };
    await this.redis.set(this.draftKey(operator, draft.draftId), JSON.stringify(draft), "EX", DRAFT_TTL_SECONDS);
    return draft;
  }

  // Only the operator who made a draft can see or submit it.
  async getDraft(operator: string, draftId: string): Promise<Draft | null> {
    if (!/^[0-9a-f]{32}$/.test(draftId)) return null;
    const raw = await this.redis.get(this.draftKey(operator, draftId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  }

  async meta(batchId: string): Promise<BatchMeta | null> {
    const h = await this.redis.hgetall(this.metaKey(batchId));
    if (!h.batchId) return null;
    return {
      batchId: h.batchId,
      operator: h.operator,
      filename: h.filename,
      total: Number(h.total),
      queued: Number(h.queued),
      status: h.status === "submitted" ? "submitted" : "submitting",
      createdAt: h.createdAt,
      submittedAt: h.submittedAt || undefined,
    };
  }

  // Newest first.
  async list(offset = 0, limit = 50): Promise<BatchMeta[]> {
    const ids = await this.redis.zrevrange(this.indexKey(), offset, offset + limit - 1);
    const metas = await Promise.all(ids.map((id) => this.meta(id)));
    return metas.filter((m): m is BatchMeta => m !== null);
  }

  async count(): Promise<number> {
    return this.redis.zcard(this.indexKey());
  }

  async submit(draft: Draft, queue: RedisStreamQueue): Promise<BatchMeta> {
    const key = this.metaKey(draft.batchId);
    // HSETNX on batchId: creates the record once; a second submit of the
    // same draft finds it and resumes (or returns it if already complete).
    if (await this.redis.hsetnx(key, "batchId", draft.batchId)) {
      await this.redis
        .multi()
        .hset(key, "operator", draft.operator, "filename", draft.filename, "total", String(draft.rows.length), "queued", "0", "status", "submitting", "createdAt", new Date().toISOString())
        .zadd(this.indexKey(), Date.now(), draft.batchId)
        .exec();
    }
    let meta = (await this.meta(draft.batchId))!;
    if (meta.status === "submitted") return meta;

    // One submitter at a time per batch, so two tabs can't both queue rows.
    // The lock expires on its own if this process dies mid-submit. A crash
    // between queuing a row and recording progress can queue that one row
    // twice on retry; STORY-103's write-once results make that harmless.
    const lock = `${key}:submit-lock`;
    const token = randomBytes(8).toString("hex");
    if ((await this.redis.set(lock, token, "EX", SUBMIT_LOCK_SECONDS, "NX")) !== "OK") throw new BatchBusyError(draft.batchId);
    try {
      return await this.queueRows(draft, queue, key, meta);
    } finally {
      if ((await this.redis.get(lock)) === token) await this.redis.del(lock);
    }
  }

  private async queueRows(draft: Draft, queue: RedisStreamQueue, key: string, meta: BatchMeta): Promise<BatchMeta> {
    meta = (await this.meta(draft.batchId)) ?? meta;
    if (meta.status === "submitted") return meta;
    for (let i = meta.queued; i < draft.rows.length; i++) {
      const row = draft.rows[i];
      const id = `${draft.batchId}-${row.row}`;
      try {
        await queue.enqueue({
          id,
          correlationId: randomUUID(),
          idempotencyKey: id,
          payload: { batchId: draft.batchId, text: row.text, row: row.row, ...(row.ref ? { ref: row.ref } : {}) },
        });
      } catch (error) {
        logJson("error", {
          event: "batch_submit_interrupted",
          correlationId: draft.batchId,
          outcome: "failure",
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
          context: { batchId: draft.batchId, queued: i, total: draft.rows.length },
        });
        throw new BatchSubmitError(i, draft.rows.length, error);
      }
      // Progress after each row, so a retry resumes exactly here.
      await this.redis.hset(key, "queued", String(i + 1));
    }
    await this.redis.hset(key, "status", "submitted", "submittedAt", new Date().toISOString());
    await this.redis.del(this.draftKey(draft.operator, draft.draftId));
    meta = (await this.meta(draft.batchId))!;
    logJson("info", { event: "batch_submitted", correlationId: draft.batchId, outcome: "success", context: { batchId: draft.batchId, operator: draft.operator, rows: meta.total } });
    return meta;
  }
}
