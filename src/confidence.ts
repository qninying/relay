// One definition of "low confidence", shared by the queue's logging
// (STORY-002, REQ-011), the review-queue routing (STORY-007, REQ-010) and
// processJob's refusal to auto-resolve, so the three can never disagree about
// which jobs need a human.
//
// REQ-011's own wording is "low-confidence," not a specific number. 0.5 is a
// placeholder; the real tuned value is a product decision for whoever owns
// the classification taxonomy (REQ-017, STORY-011).

import type { Job } from "./processJob.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function isLowConfidence(job: Job): boolean {
  return typeof job.confidence === "number" && job.confidence < LOW_CONFIDENCE_THRESHOLD;
}
