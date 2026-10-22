// STORY-106: building a review decision from a form (pure), and the
// outcome contract for reviewed items.

import { describe, it, expect } from "vitest";
import { buildDecision, MAX_NOTE_CHARS } from "./reviewPages.js";
import type { ReviewItem } from "./reviewItems.js";
import type { Taxonomy } from "../taxonomy.js";
import { checkOutcome } from "../batchResults.js";

const taxonomy = (version: string, codes: string[]): Taxonomy => ({
  id: "industry",
  version,
  sha256: "x",
  reviewThreshold: 0.5,
  labels: codes.map((code) => ({ code, name: code, description: "" })),
  codes: new Set(codes),
});
const v1 = taxonomy("1.0.0", ["software", "healthcare", "other"]);
const item: ReviewItem = {
  messageId: "1-0",
  jobId: "b1-3",
  correlationId: "c",
  reason: "low_confidence",
  routedAt: "",
  confidence: 0.3,
  threshold: 0.5,
  batch: { batchId: "b1", row: 3, text: "The Corner Bakery", label: "other", taxonomyId: "industry", taxonomyVersion: "1.0.0" },
};
const now = new Date("2026-10-22T12:00:00Z");
const decide = (fields: Record<string, string>, tax = v1, it = item) => buildDecision(it, new URLSearchParams(fields), tax, "ana", now);

describe("buildDecision", () => {
  it("approve keeps the model's label and counts as done", () => {
    const d = decide({ decision: "approve" });
    expect(d).toEqual({ ok: true, summary: "approved other", outcome: { status: "done", label: "other", confidence: 0.3, taxonomyVersion: "1.0.0", reviewDecision: "approved", reviewedBy: "ana", at: now.toISOString() } });
    if (d.ok) expect(checkOutcome(d.outcome)).toEqual([]);
  });

  it("correct records the new label and what the model said", () => {
    const d = decide({ decision: "correct", label: "healthcare", note: " looked it up " });
    expect(d.ok && d.outcome).toEqual({ status: "done", label: "healthcare", confidence: 0.3, taxonomyVersion: "1.0.0", reviewDecision: "corrected", modelLabel: "other", reviewedBy: "ana", note: "looked it up", at: now.toISOString() });
    if (d.ok) expect(checkOutcome(d.outcome)).toEqual([]);
  });

  it("reject needs a note and records it", () => {
    expect(decide({ decision: "reject" })).toMatchObject({ ok: false, status: 422 });
    expect(decide({ decision: "reject", note: "   " })).toMatchObject({ ok: false, status: 422 });
    const d = decide({ decision: "reject", note: "Not a company" });
    expect(d.ok && d.outcome).toMatchObject({ status: "rejected", label: "other", reviewDecision: "rejected", note: "Not a company" });
    if (d.ok) expect(checkOutcome(d.outcome)).toEqual([]);
  });

  it("refuses labels outside the fixed taxonomy, the model's own label as a correction, unknown decisions, and long notes", () => {
    expect(decide({ decision: "correct", label: "crypto" })).toMatchObject({ ok: false, status: 422, message: "Choose a label from the taxonomy." });
    expect(decide({ decision: "correct" })).toMatchObject({ ok: false, status: 422 });
    expect(decide({ decision: "correct", label: "other" })).toMatchObject({ ok: false, status: 422 });
    expect(decide({ decision: "delete" })).toMatchObject({ ok: false, status: 400 });
    expect(decide({ decision: "approve", note: "x".repeat(MAX_NOTE_CHARS + 1) })).toMatchObject({ ok: false, status: 422 });
    expect(decide({ decision: "approve", note: "x".repeat(MAX_NOTE_CHARS) }).ok).toBe(true);
  });

  it("taxonomy changed: approve only if the label still exists; a correction records both versions", () => {
    const v2 = taxonomy("2.0.0", ["software", "healthcare", "food_and_beverage"]);
    expect(decide({ decision: "approve" }, v2)).toMatchObject({ ok: false, status: 422, message: expect.stringContaining("isn't a label in taxonomy version 2.0.0") });
    const d = decide({ decision: "correct", label: "food_and_beverage" }, v2);
    expect(d.ok && d.outcome).toMatchObject({ label: "food_and_beverage", taxonomyVersion: "2.0.0", modelLabel: "other", modelTaxonomyVersion: "1.0.0" });
    const kept = taxonomy("2.0.0", ["other", "software"]);
    expect(decide({ decision: "approve" }, kept).ok && (decide({ decision: "approve" }, kept) as { outcome: { taxonomyVersion: string } }).outcome.taxonomyVersion).toBe("1.0.0");
  });

  it("an item that isn't from a batch can't be decided here", () => {
    const { batch: _ignored, ...plain } = item;
    expect(decide({ decision: "approve" }, v1, plain)).toMatchObject({ ok: false, status: 422 });
  });
});

describe("outcome contract for reviewed items", () => {
  const at = now.toISOString();
  it("refuses a half-recorded review, a wrong decision for the status, and a rejection without a note", () => {
    expect(checkOutcome({ status: "done", label: "x", confidence: 0.3, taxonomyVersion: "1", at, reviewDecision: "approved" })).toContain("INCOMPLETE_REVIEW");
    expect(checkOutcome({ status: "done", label: "x", confidence: 0.3, taxonomyVersion: "1", at, reviewedBy: "ana", reviewDecision: "rejected" })).toContain("BAD_REVIEW_DECISION");
    expect(checkOutcome({ status: "rejected", label: "x", confidence: 0.3, taxonomyVersion: "1", at, reviewedBy: "ana", reviewDecision: "rejected" }).length).toBeGreaterThan(0);
  });
});
