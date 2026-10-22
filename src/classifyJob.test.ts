// STORY-011: classification against the fixed taxonomy. Uses the real
// pinned taxonomy file for the happy path, and temp files for the failure
// paths (missing, changed, malformed).

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyJob, cachedTaxonomy, withClassification, type Classifier } from "./classifyJob.js";
import {
  INDUSTRY_TAXONOMY_PIN,
  loadTaxonomy,
  TaxonomyInvalidError,
  TaxonomyMismatchError,
  TaxonomyNotFoundError,
  type TaxonomyPin,
} from "./taxonomy.js";
import { isLowConfidence } from "./confidence.js";
import { getDroppedLogCount } from "./logger.js";
import type { Job } from "./processJob.js";

const reliability = { timeoutMs: 100, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

function job(text: unknown = "Acme builds cloud accounting software for small firms."): Job {
  return { id: "job-1", correlationId: "corr-cls-1", idempotencyKey: "idem-1", payload: { text } };
}

function captureLogs() {
  const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return () => spies.flatMap((s) => s.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, any>));
}

let dir: string;
async function pinFor(name: string, content: string, overrides: Partial<TaxonomyPin> = {}): Promise<TaxonomyPin> {
  const path = join(dir, name);
  await writeFile(path, content);
  return { path, version: "1.0.0", sha256: createHash("sha256").update(content).digest("hex"), ...overrides };
}

function taxonomyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "test",
    version: "1.0.0",
    reviewThreshold: 0.7,
    labels: [
      { code: "software", name: "Software", description: "" },
      { code: "other", name: "Other", description: "" },
    ],
    ...overrides,
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "relay-taxonomy-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

describe("the pinned taxonomy file", () => {
  it("loads, matches its pin, and has unique well-formed codes", async () => {
    const taxonomy = await loadTaxonomy(INDUSTRY_TAXONOMY_PIN);
    expect(taxonomy).toMatchObject({ id: "industry", version: "1.0.0", sha256: INDUSTRY_TAXONOMY_PIN.sha256, reviewThreshold: 0.5 });
    expect(taxonomy.codes.size).toBe(taxonomy.labels.length);
    expect(taxonomy.codes.has("software")).toBe(true);
  });
});

describe("criterion 1: classification uses the fixed taxonomy", () => {
  it("shows the classifier exactly the taxonomy's labels and accepts a label from it", async () => {
    const logs = captureLogs();
    const classifier = vi.fn<Classifier>().mockResolvedValue({ label: "software", confidence: 0.92 });
    const result = await classifyJob(job(), classifier, { reliability });

    const taxonomy = await loadTaxonomy(INDUSTRY_TAXONOMY_PIN);
    expect(classifier).toHaveBeenCalledWith({ text: job().payload && (job().payload as { text: string }).text, labels: taxonomy.labels });
    expect(result).toEqual({
      status: "classified",
      label: "software",
      confidence: 0.92,
      needsReview: false,
      taxonomy: { id: "industry", version: "1.0.0", sha256: INDUSTRY_TAXONOMY_PIN.sha256 },
    });
    // Trust: logged with the taxonomy version (and id + hash) and the job's correlation ID.
    expect(logs().find((l) => l.event === "classification_completed")).toMatchObject({
      correlationId: "corr-cls-1",
      context: { label: "software", taxonomy: { id: "industry", version: "1.0.0", sha256: INDUSTRY_TAXONOMY_PIN.sha256 } },
    });
  });

  it("rejects a label the classifier invented, instead of creating a category", async () => {
    const logs = captureLogs();
    const result = await classifyJob(job(), async () => ({ label: "crypto_web3", confidence: 0.99 }), { reliability });
    expect(result).toMatchObject({ status: "failed", reason: "out_of_taxonomy", returnedLabel: "crypto_web3", taxonomy: { version: "1.0.0" } });
    expect(logs().find((l) => l.event === "classification_failed")).toMatchObject({
      correlationId: "corr-cls-1",
      context: { reason: "out_of_taxonomy", taxonomy: { version: "1.0.0" } },
    });
  });

  it("rejects a near-miss label (case or spacing), since the taxonomy's codes are exact", async () => {
    captureLogs();
    expect(await classifyJob(job(), async () => ({ label: "Software", confidence: 0.9 }), { reliability })).toMatchObject({ reason: "out_of_taxonomy" });
    expect(await classifyJob(job(), async () => ({ label: " software", confidence: 0.9 }), { reliability })).toMatchObject({ reason: "out_of_taxonomy" });
  });

  it.each([1.5, -0.1, Number.NaN, "0.9"])("rejects confidence %s outside 0..1", async (confidence) => {
    captureLogs();
    const result = await classifyJob(job(), async () => ({ label: "software", confidence: confidence as number }), { reliability });
    expect(result).toMatchObject({ status: "failed", reason: "invalid_confidence" });
  });

  it("uses the taxonomy's own review threshold, and routing honors it", async () => {
    captureLogs();
    const pin = await pinFor("strict.json", taxonomyJson({ reviewThreshold: 0.7 }));
    const result = await classifyJob(job(), async () => ({ label: "software", confidence: 0.6 }), {
      reliability,
      getTaxonomy: () => loadTaxonomy(pin),
    });
    expect(result).toMatchObject({ status: "classified", needsReview: true });
    if (result.status !== "classified") throw new Error("unreachable");
    const classified = withClassification(job(), result, 0.7);
    // 0.6 would pass the global 0.5 fallback; the taxonomy's 0.7 sends it to review.
    expect(isLowConfidence(classified)).toBe(true);
    expect(classified.payload).toMatchObject({ text: expect.any(String), classification: { label: "software", taxonomy: { id: "test" } } });
  });
});

describe("criterion 2: taxonomy unavailable fails gracefully", () => {
  it("missing file: fails without calling the classifier, and says why", async () => {
    const logs = captureLogs();
    const classifier = vi.fn<Classifier>();
    const result = await classifyJob(job(), classifier, {
      reliability,
      getTaxonomy: () => loadTaxonomy({ ...INDUSTRY_TAXONOMY_PIN, path: join(dir, "nope.json") }),
    });
    expect(result).toEqual({ status: "failed", reason: "taxonomy_unavailable", errorClass: "TaxonomyNotFoundError" });
    expect(classifier).not.toHaveBeenCalled();
    expect(logs().find((l) => l.event === "classification_failed")).toMatchObject({ correlationId: "corr-cls-1", errorClass: "TaxonomyNotFoundError" });
  });

  it("changed file (hash no longer matches the pin) is refused", async () => {
    const pin = await pinFor("drifted.json", taxonomyJson());
    await writeFile(pin.path, taxonomyJson({ labels: [{ code: "software", name: "Software", description: "" }, { code: "crypto", name: "Crypto", description: "" }] }));
    await expect(loadTaxonomy(pin)).rejects.toBeInstanceOf(TaxonomyMismatchError);
  });

  it("version bumped in the file without updating the pin is refused", async () => {
    const pin = await pinFor("v2.json", taxonomyJson({ version: "2.0.0" }));
    await expect(loadTaxonomy(pin)).rejects.toBeInstanceOf(TaxonomyMismatchError);
  });

  it.each([
    ["not JSON", "{oops"],
    ["no labels", taxonomyJson({ labels: [] })],
    ["duplicate codes", taxonomyJson({ labels: [{ code: "a", name: "A" }, { code: "a", name: "A again" }] })],
    ["bad code", taxonomyJson({ labels: [{ code: "Has Spaces", name: "x" }] })],
    ["threshold out of range", taxonomyJson({ reviewThreshold: 1.5 })],
  ])("malformed taxonomy (%s) is refused", async (_name, content) => {
    const pin = await pinFor(`bad-${Math.random()}.json`, content);
    await expect(loadTaxonomy(pin)).rejects.toBeInstanceOf(TaxonomyInvalidError);
  });

  it("a failed load isn't cached: once the file is restored, the next task succeeds", async () => {
    captureLogs();
    const content = taxonomyJson();
    const path = join(dir, "restored.json");
    const pin = { path, version: "1.0.0", sha256: createHash("sha256").update(content).digest("hex") };
    const getTaxonomy = cachedTaxonomy(pin);
    const classify = () => classifyJob(job(), async () => ({ label: "software", confidence: 0.9 }), { reliability, getTaxonomy });
    expect(await classify()).toMatchObject({ reason: "taxonomy_unavailable" });
    await writeFile(path, content);
    expect(await classify()).toMatchObject({ status: "classified" });
    await expect(getTaxonomy()).resolves.toBeDefined();
    expect(TaxonomyNotFoundError).toBeDefined();
  });
});

describe("failure paths: classification task fails, logging unavailable", () => {
  it("a failing classifier is retried (capped), then the task fails with the taxonomy recorded", async () => {
    captureLogs();
    const classifier = vi.fn<Classifier>().mockRejectedValue(Object.assign(new Error("503"), { status: 503 }));
    const result = await classifyJob(job(), classifier, { reliability });
    expect(classifier).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "failed", reason: "classifier_failed", errorClass: "UpstreamCallFailedError", taxonomy: { version: "1.0.0" } });
  });

  it("a hanging classifier is cut off by the timeout", async () => {
    captureLogs();
    const result = await classifyJob(job(), () => new Promise(() => {}), { reliability: { ...reliability, maxRetries: 0 } });
    expect(result).toMatchObject({ status: "failed", reason: "classifier_failed" });
  });

  it("missing or empty input text fails without calling the classifier", async () => {
    captureLogs();
    const classifier = vi.fn<Classifier>();
    expect(await classifyJob(job(""), classifier, { reliability })).toMatchObject({ reason: "invalid_input" });
    expect(await classifyJob(job(null), classifier, { reliability })).toMatchObject({ reason: "invalid_input" });
    expect(await classifyJob({ ...job(), payload: {} }, classifier, { reliability })).toMatchObject({ reason: "invalid_input" });
    expect(classifier).not.toHaveBeenCalled();
  });

  it("with logging down, classification still completes and the result itself carries the taxonomy version", async () => {
    const broken = () => {
      throw new Error("EPIPE");
    };
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(broken);
    const before = getDroppedLogCount();
    const result = await classifyJob(job(), async () => ({ label: "healthcare", confidence: 0.8 }), { reliability });
    expect(result).toMatchObject({ status: "classified", label: "healthcare", taxonomy: { version: "1.0.0", sha256: INDUSTRY_TAXONOMY_PIN.sha256 } });
    expect(getDroppedLogCount()).toBeGreaterThan(before);
  });
});
