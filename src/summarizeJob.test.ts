// STORY-012 against REAL Redis (source archive, review queue): summaries are
// built only from fetched source data, checked against it, archived for
// later verification, and every outcome is logged with the source reference.
// Skips cleanly if Redis isn't reachable.

import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { summarizeJob, verifySummary, type Summarizer, type SourceProvider } from "./summarizeJob.js";
import { RedisSourceArchive, sha256Of } from "./sourceArchive.js";
import { RedisStreamQueue } from "./queue.js";
import { getDroppedLogCount } from "./logger.js";
import type { Job } from "./processJob.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) {
  console.warn("[summarizeJob.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");
}

const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `relay:test:source:${RUN}:`;
const REVIEW_KEY = `relay:test:summary-review:${RUN}`;
const DLQ_KEY = `relay:test:summary-dlq:${RUN}`;

const SOURCE =
  "Acme Logistics operates 42 warehouses across Texas and Oklahoma. The company was founded in 2009 " +
  "and provides freight forwarding, cold storage and last-mile delivery for regional grocery chains.";
const GROUNDED = "Acme Logistics operates 42 warehouses in Texas and Oklahoma, providing freight forwarding, cold storage and last-mile delivery for grocery chains.";

const reliability = { timeoutMs: 100, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

function job(id = "acme"): Job {
  return { id, correlationId: `corr-sum-${id}`, idempotencyKey: `idem-sum-${id}-${RUN}`, payload: { url: "https://example.com/acme" } };
}
const source = (text = SOURCE): SourceProvider => async () => ({ sourceId: "https://example.com/acme", text });
const summarizerSaying = (summary: string) => vi.fn<Summarizer>().mockResolvedValue({ summary });

function captureLogs() {
  const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return () => spies.flatMap((s) => s.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, any>));
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = await redis.keys(`${PREFIX}*`);
  await redis.del(...keys, REVIEW_KEY, DLQ_KEY);
});

describe.skipIf(!redisAvailable)("grounded summaries (integration, real Redis)", () => {
  const archive = new RedisSourceArchive(redis, PREFIX);
  const reviewQueue = new RedisStreamQueue(redis, REVIEW_KEY, "g-review");

  it("criterion 1: a summary is built from the item's source and only returned when grounded in it", async () => {
    captureLogs();
    const summarizer = summarizerSaying(GROUNDED);
    const result = await summarizeJob(job(), summarizer, source(), { reliability, archive, reviewQueue });

    expect(summarizer).toHaveBeenCalledWith({ sourceText: SOURCE });
    expect(result).toMatchObject({
      status: "grounded",
      summary: GROUNDED,
      source: { sourceId: "https://example.com/acme", sha256: sha256Of(SOURCE), chars: SOURCE.length },
    });
  });

  it("criterion 1: a summary with a number not in the source is rejected and sent to review, not returned", async () => {
    const logs = captureLogs();
    const before = (await reviewQueue.peek(100)).length;
    const result = await summarizeJob(job("acme-num"), summarizerSaying(GROUNDED.replace("42", "58")), source(), { reliability, archive, reviewQueue });

    expect(result).toMatchObject({ status: "ungrounded", violations: ["UNGROUNDED_NUMBER"], routedTo: "review" });
    expect(result).not.toHaveProperty("summary");
    const entry = (await reviewQueue.peek(100))[before];
    expect(entry).toMatchObject({
      id: "acme-num",
      payload: { reason: "ungrounded_summary", violations: ["UNGROUNDED_NUMBER"], source: { sha256: sha256Of(SOURCE) } },
    });
    expect(logs().find((l) => l.event === "job_routed_to_review")).toMatchObject({ correlationId: "corr-sum-acme-num", context: { reason: "ungrounded_summary" } });
  });

  it("criterion 1: a summary that drifts off the source (low overlap) is rejected", async () => {
    captureLogs();
    const result = await summarizeJob(job("acme-drift"), summarizerSaying("A fast-growing fintech disrupting payments with blockchain innovation everywhere."), source(), {
      reliability,
      archive,
    });
    expect(result).toMatchObject({ status: "ungrounded", violations: ["LOW_LEXICAL_OVERLAP"], routedTo: null });
  });

  it("criterion 2: missing source data fails the summary, and the summarizer is never called", async () => {
    const logs = captureLogs();
    const summarizer = summarizerSaying(GROUNDED);
    expect(await summarizeJob(job("none"), summarizer, async () => null, { reliability, archive })).toEqual({ status: "failed", reason: "source_missing" });
    expect(await summarizeJob(job("blank"), summarizer, source("   "), { reliability, archive })).toEqual({ status: "failed", reason: "source_missing" });
    expect(summarizer).not.toHaveBeenCalled();
    expect(logs().find((l) => l.event === "summary_failed")).toMatchObject({ correlationId: "corr-sum-none", context: { reason: "source_missing" } });
  });

  it("criterion 2: a source fetch that keeps failing (or hangs) fails the summary after capped retries", async () => {
    captureLogs();
    const fetchSource = vi.fn<SourceProvider>().mockRejectedValue(Object.assign(new Error("503"), { status: 503 }));
    const summarizer = summarizerSaying(GROUNDED);
    expect(await summarizeJob(job("down"), summarizer, fetchSource, { reliability, archive })).toMatchObject({ status: "failed", reason: "source_unavailable", errorClass: "UpstreamCallFailedError" });
    expect(fetchSource).toHaveBeenCalledTimes(3);
    expect(await summarizeJob(job("hang"), summarizer, () => new Promise(() => {}), { reliability: { ...reliability, maxRetries: 0 }, archive })).toMatchObject({ reason: "source_unavailable" });
    expect(summarizer).not.toHaveBeenCalled();
  });

  it("trust: the source is logged and archived, and the summary can be verified against it later", async () => {
    const logs = captureLogs();
    const result = await summarizeJob(job("audit"), summarizerSaying(GROUNDED), source(), { reliability, archive });
    expect(result.status).toBe("grounded");

    const line = logs().find((l) => l.event === "summary_generated");
    expect(line).toMatchObject({
      correlationId: "corr-sum-audit",
      context: { source: { sourceId: "https://example.com/acme", sha256: sha256Of(SOURCE), chars: SOURCE.length } },
    });
    // An auditor holding only the summary and the logged hash:
    expect(await verifySummary(GROUNDED, line!.context.source.sha256, archive)).toEqual({ verified: true, sourceId: "https://example.com/acme" });
    expect(await verifySummary("Acme operates 99 warehouses.", line!.context.source.sha256, archive)).toEqual({ verified: false, reason: "not_grounded" });
    expect(await verifySummary(GROUNDED, sha256Of("some other text"), archive)).toEqual({ verified: false, reason: "source_not_found" });
  });

  it("the archive is content-addressed and idempotent: the same source twice is one entry, and tampering is detected", async () => {
    const first = await archive.put("a", "same text for idempotency " + RUN);
    const second = await archive.put("b", "same text for idempotency " + RUN);
    expect(second.sha256).toBe(first.sha256);
    expect((await archive.get(first.sha256))?.sourceId).toBe("a"); // NX kept the first
    expect(await redis.ttl(PREFIX + first.sha256)).toBeGreaterThan(0);

    const tamperedKey = PREFIX + first.sha256;
    const stored = JSON.parse((await redis.get(tamperedKey))!);
    await redis.set(tamperedKey, JSON.stringify({ ...stored, text: stored.text + " (edited)" }));
    expect(await archive.get(first.sha256)).toBeNull();
  });

  it("failure path: summarizer fails, and the failure carries the source it was working from", async () => {
    captureLogs();
    const summarizer = vi.fn<Summarizer>().mockRejectedValue(new Error("model overloaded"));
    expect(await summarizeJob(job("sfail"), summarizer, source(), { reliability, archive })).toMatchObject({
      status: "failed",
      reason: "summarizer_failed",
      source: { sha256: sha256Of(SOURCE) },
    });
    expect(summarizer).toHaveBeenCalledTimes(3);
  });

  it("failure path: an empty summary is rejected as ungrounded, not returned", async () => {
    captureLogs();
    expect(await summarizeJob(job("empty"), summarizerSaying("   "), source(), { reliability, archive })).toMatchObject({ status: "ungrounded", violations: ["SUMMARY_EMPTY"] });
  });

  it("failure path: if the source can't be archived, no unverifiable summary is produced", async () => {
    captureLogs();
    const dead = new Redis({ port: 1, lazyConnect: true, retryStrategy: () => null, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    dead.on("error", () => {});
    const summarizer = summarizerSaying(GROUNDED);
    expect(await summarizeJob(job("noarchive"), summarizer, source(), { reliability, archive: new RedisSourceArchive(dead, PREFIX) })).toMatchObject({
      status: "failed",
      reason: "source_not_archived",
    });
    expect(summarizer).not.toHaveBeenCalled();
    dead.disconnect();
  });

  it("failure path: review queue down falls back to the DLQ, so a rejected summary is never lost", async () => {
    captureLogs();
    const broken = { enqueue: vi.fn().mockRejectedValue(new Error("READONLY")) } as unknown as RedisStreamQueue;
    const result = await summarizeJob(job("fallback"), summarizerSaying(GROUNDED.replace("42", "7")), source(), {
      reliability,
      archive,
      reviewQueue: broken,
      reviewOptions: { dlq: new RedisStreamQueue(redis, DLQ_KEY, "g-dlq"), maxAttempts: 2, backoffMs: 1 },
    });
    expect(result).toMatchObject({ status: "ungrounded", routedTo: "dlq" });
    expect(await redis.xlen(DLQ_KEY)).toBe(1);
  });

  it("failure path: with logging down, the summary still completes and the result carries the source reference", async () => {
    const brokenLog = () => {
      throw new Error("EPIPE");
    };
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(brokenLog);
    const before = getDroppedLogCount();
    const result = await summarizeJob(job("nolog"), summarizerSaying(GROUNDED), source(), { reliability, archive });
    expect(result).toMatchObject({ status: "grounded", source: { sha256: sha256Of(SOURCE) } });
    expect(getDroppedLogCount()).toBeGreaterThan(before);
  });
});
