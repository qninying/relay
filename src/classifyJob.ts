// STORY-011 (REQ-017): a classification task that can only produce a label
// from the fixed taxonomy. The classifier (in production an LLM or vendor
// API, injected here) is shown the taxonomy's labels and nothing else, and
// whatever it returns is checked against the taxonomy's codes before it is
// accepted: an invented label is a failed task, never a new category.
//
// Every outcome is logged with the taxonomy id, version and sha256, and the
// same three fields are on the result itself, so the audit record survives
// even when logging is down (logger.ts counts lines it couldn't write).
//
// Failure paths:
// - Taxonomy not found / invalid / changed: fails with reason
//   taxonomy_unavailable before the classifier is ever called. Nothing is
//   guessed, and the job's payload is untouched for a retry.
// - Classifier fails or hangs: withReliability's timeout and capped retries
//   (following the STORY-008 retry policy when one is passed), then fails
//   with reason classifier_failed.
// - Classifier returns a label outside the taxonomy, or a confidence outside
//   0..1: fails with reason out_of_taxonomy / invalid_confidence.

import { logJson } from "./logger.js";
import type { Job } from "./processJob.js";
import { withReliability, type ReliabilityOptions } from "./withReliability.js";
import { INDUSTRY_TAXONOMY_PIN, loadTaxonomy, type Taxonomy, type TaxonomyLabel, type TaxonomyPin } from "./taxonomy.js";

export interface ClassifierInput {
  text: string;
  labels: TaxonomyLabel[];
}

export interface ClassifierOutput {
  label: string;
  confidence: number;
}

export type Classifier = (input: ClassifierInput) => Promise<ClassifierOutput>;

export interface TaxonomyRef {
  id: string;
  version: string;
  sha256: string;
}

export type ClassificationResult =
  | { status: "classified"; label: string; confidence: number; needsReview: boolean; taxonomy: TaxonomyRef }
  | { status: "failed"; reason: "taxonomy_unavailable"; errorClass: string }
  | { status: "failed"; reason: "invalid_input"; taxonomy: TaxonomyRef }
  | { status: "failed"; reason: "classifier_failed"; errorClass: string; taxonomy: TaxonomyRef }
  | { status: "failed"; reason: "out_of_taxonomy"; returnedLabel: string; taxonomy: TaxonomyRef }
  | { status: "failed"; reason: "invalid_confidence"; taxonomy: TaxonomyRef };

export interface ClassifyOptions {
  reliability: Omit<ReliabilityOptions, "circuitBreaker">;
  getTaxonomy?: () => Promise<Taxonomy>;
}

// Loads once and reuses it; a failed load is not cached, so the next task
// tries again (the file may have been restored).
export function cachedTaxonomy(pin: TaxonomyPin = INDUSTRY_TAXONOMY_PIN): () => Promise<Taxonomy> {
  let loaded: Promise<Taxonomy> | null = null;
  return () => {
    if (!loaded) {
      loaded = loadTaxonomy(pin).catch((error) => {
        loaded = null;
        throw error;
      });
    }
    return loaded;
  };
}

const defaultTaxonomy = cachedTaxonomy();

function ref(taxonomy: Taxonomy): TaxonomyRef {
  return { id: taxonomy.id, version: taxonomy.version, sha256: taxonomy.sha256 };
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

export async function classifyJob(job: Job, classifier: Classifier, options: ClassifyOptions): Promise<ClassificationResult> {
  const { correlationId } = job;

  let taxonomy: Taxonomy;
  try {
    taxonomy = await (options.getTaxonomy ?? defaultTaxonomy)();
  } catch (error) {
    const errorClass = errorClassOf(error);
    logJson("error", {
      event: "classification_failed",
      correlationId,
      outcome: "failure",
      errorClass,
      context: { jobId: job.id, reason: "taxonomy_unavailable" },
    });
    return { status: "failed", reason: "taxonomy_unavailable", errorClass };
  }
  const taxonomyRef = ref(taxonomy);
  const fail = (result: ClassificationResult, context: Record<string, unknown> = {}) => {
    logJson("error", {
      event: "classification_failed",
      correlationId,
      outcome: "failure",
      errorClass: "errorClass" in result ? result.errorClass : undefined,
      context: { jobId: job.id, reason: "reason" in result ? result.reason : undefined, taxonomy: taxonomyRef, ...context },
    });
    return result;
  };

  const text = (job.payload as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return fail({ status: "failed", reason: "invalid_input", taxonomy: taxonomyRef });
  }

  let output: ClassifierOutput;
  try {
    output = await withReliability(() => classifier({ text, labels: taxonomy.labels }), options.reliability);
  } catch (error) {
    return fail({ status: "failed", reason: "classifier_failed", errorClass: errorClassOf(error), taxonomy: taxonomyRef });
  }

  if (!taxonomy.codes.has(output?.label)) {
    return fail({ status: "failed", reason: "out_of_taxonomy", returnedLabel: String(output?.label), taxonomy: taxonomyRef });
  }
  if (typeof output.confidence !== "number" || !(output.confidence >= 0 && output.confidence <= 1)) {
    return fail({ status: "failed", reason: "invalid_confidence", taxonomy: taxonomyRef }, { returnedConfidence: String(output.confidence) });
  }

  const needsReview = output.confidence < taxonomy.reviewThreshold;
  logJson("info", {
    event: "classification_completed",
    correlationId,
    outcome: "success",
    context: { jobId: job.id, label: output.label, confidence: output.confidence, needsReview, taxonomy: taxonomyRef },
  });
  return { status: "classified", label: output.label, confidence: output.confidence, needsReview, taxonomy: taxonomyRef };
}

// The classified job, ready for jobRouter (STORY-007): carries the confidence
// and the taxonomy's own review threshold, so routing to review uses the
// threshold the taxonomy owner set rather than the global placeholder.
export function withClassification(job: Job, result: Extract<ClassificationResult, { status: "classified" }>, reviewThreshold: number): Job {
  return {
    ...job,
    confidence: result.confidence,
    reviewThreshold,
    payload: { ...(job.payload as Record<string, unknown>), classification: { label: result.label, taxonomy: result.taxonomy } },
  };
}
