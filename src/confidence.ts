// One definition of "low confidence", shared by the queue's logging
// (STORY-002, REQ-011), the review-queue routing (STORY-007, REQ-010) and
// processJob's refusal to auto-resolve, so the three can never disagree about
// which jobs need a human.
//
// STORY-011: a classified job carries the review threshold of the taxonomy
// that classified it (taxonomies/*.json, owned by whoever owns the labels).
// LOW_CONFIDENCE_THRESHOLD is only the fallback for jobs with a confidence
// but no taxonomy threshold.

import type { Job } from "./processJob.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function reviewThresholdFor(job: Job): number {
  return job.reviewThreshold ?? LOW_CONFIDENCE_THRESHOLD;
}

export function isLowConfidence(job: Job): boolean {
  return typeof job.confidence === "number" && job.confidence < reviewThresholdFor(job);
}
