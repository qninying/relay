// STORY-103 (REQ-115): what a worker does with one batch item. A batch item
// is a job whose payload has a batchId and the text to classify (enqueued by
// the console's batch upload, STORY-104).
//
//   classify (classifyJob: fixed taxonomy, timeout + capped retries)
//     -> confident:      record "done" with label, confidence, taxonomy
//                        version, then claim + log job_processed
//     -> not confident:  record "review" AND add the review-queue entry, in
//                        one atomic step (batchResults.ts)
//     -> failed:         record "failed" with the reason; no label stored;
//                        log job_failed
//
// A redelivered item finds its outcome already recorded and does nothing
// (logged as job_skipped_duplicate), so results are written once.

import { logJson } from "./logger.js";
import type { Job } from "./processJob.js";
import { processJobDurable } from "./processJob.js";
import type { DurableIdempotencyStore } from "./idempotencyStore.js";
import { cachedTaxonomy, classifyJob, withClassification, type Classifier } from "./classifyJob.js";
import type { Taxonomy } from "./taxonomy.js";
import type { ReliabilityOptions } from "./withReliability.js";
import { buildReviewEntry } from "./reviewQueue.js";
import type { BatchResults, ItemOutcome } from "./batchResults.js";

export interface BatchPayload {
  batchId: string;
  text: string;
}

export function batchPayload(job: Job): BatchPayload | null {
  const p = job.payload as Partial<BatchPayload> | null;
  return p && typeof p.batchId === "string" && p.batchId && typeof p.text === "string" ? { batchId: p.batchId, text: p.text } : null;
}

export interface BatchWorkerDeps {
  classifier: Classifier;
  results: BatchResults;
  reviewStream: string;
  durableStore: DurableIdempotencyStore;
  reliability?: Omit<ReliabilityOptions, "circuitBreaker">;
  getTaxonomy?: () => Promise<Taxonomy>;
}

export type BatchItemResult = { recorded: boolean; status: ItemOutcome["status"] };

const DEFAULT_RELIABILITY = { timeoutMs: 10_000, maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 };
const defaultTaxonomy = cachedTaxonomy();

export async function handleBatchItem(job: Job, payload: BatchPayload, deps: BatchWorkerDeps): Promise<BatchItemResult> {
  const getTaxonomy = deps.getTaxonomy ?? defaultTaxonomy;
  const at = new Date().toISOString();
  const result = await classifyJob(job, deps.classifier, { reliability: deps.reliability ?? DEFAULT_RELIABILITY, getTaxonomy });

  if (result.status === "failed") {
    const outcome: ItemOutcome = { status: "failed", reason: result.reason, at, ...("taxonomy" in result ? { taxonomyVersion: result.taxonomy.version } : {}) };
    const recorded = await deps.results.record(payload.batchId, job.id, outcome);
    if (recorded) {
      logJson("error", {
        event: "job_failed",
        correlationId: job.correlationId,
        outcome: "failure",
        errorClass: "errorClass" in result ? result.errorClass : "ClassificationRejected",
        context: { jobId: job.id, batchId: payload.batchId, reason: result.reason },
      });
    } else {
      skipped(job, payload);
    }
    return { recorded, status: "failed" };
  }

  const base = { label: result.label, confidence: result.confidence, taxonomyVersion: result.taxonomy.version, at };
  if (result.needsReview) {
    const taxonomy = await getTaxonomy();
    const classified = withClassification(job, result, taxonomy.reviewThreshold);
    const entry = buildReviewEntry(classified, "low_confidence", { batchId: payload.batchId, label: result.label, taxonomy: result.taxonomy });
    const recorded = await deps.results.record(payload.batchId, job.id, { status: "review", ...base }, { stream: deps.reviewStream, entry });
    if (recorded) {
      logJson("info", {
        event: "job_routed_to_review",
        correlationId: job.correlationId,
        outcome: "success",
        context: { jobId: job.id, batchId: payload.batchId, reason: "low_confidence", confidence: result.confidence, threshold: taxonomy.reviewThreshold },
      });
    } else {
      skipped(job, payload);
    }
    return { recorded, status: "review" };
  }

  const recorded = await deps.results.record(payload.batchId, job.id, { status: "done", ...base });
  if (!recorded) {
    skipped(job, payload);
    return { recorded, status: "done" };
  }
  // Claim + job_processed log (and STORY-005 metrics via the tracker). The
  // stored result above is the commit point; this keeps job accounting
  // consistent with non-batch jobs.
  await processJobDurable({ ...job, confidence: undefined }, deps.durableStore);
  return { recorded, status: "done" };
}

function skipped(job: Job, payload: BatchPayload): void {
  logJson("info", {
    event: "job_skipped_duplicate",
    correlationId: job.correlationId,
    outcome: "skipped",
    context: { jobId: job.id, batchId: payload.batchId, reason: "result_already_recorded" },
  });
}
