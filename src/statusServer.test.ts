// STORY-010 against REAL Redis: the monitoring sampler records samples over
// time (and logs each with a correlation ID), and the status server serves
// the plain-language view, history and health, read-only. Skips cleanly if
// Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { RedisStreamQueue } from "./queue.js";
import { MetricsCollector } from "./metrics.js";
import { JobOutcomeTracker } from "./jobOutcomeTracker.js";
import { MonitoringSampler } from "./monitoringSampler.js";
import { createStatusServer } from "./statusServer.js";

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
  console.warn("[statusServer.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");
}

const RUN = Math.random().toString(36).slice(2, 8);
const K = { jobs: `relay:test:mon:${RUN}`, dlq: `relay:test:mon:${RUN}:dlq`, review: `relay:test:mon:${RUN}:review`, history: `relay:test:mon:${RUN}:metrics` };

function build(redisClient: Redis) {
  const queue = new RedisStreamQueue(redisClient, K.jobs, "g");
  const metrics = new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.9 });
  const tracker = new JobOutcomeTracker(metrics);
  const sampler = new MonitoringSampler({
    redis: redisClient,
    queue,
    queueStream: K.jobs,
    queueGroup: "g",
    dlqStream: K.dlq,
    reviewStream: K.review,
    metrics,
    tracker,
    workerCount: () => 2,
    historyKey: K.history,
    maxSamples: 100,
  });
  return { queue, metrics, tracker, sampler };
}

function captureLogs() {
  const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return () => spies.flatMap((s) => s.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, any>));
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (redisAvailable) await redis.del(...Object.values(K));
});

describe.skipIf(!redisAvailable)("monitoring + status server (integration, real Redis)", () => {
  let server: http.Server;
  let baseUrl: string;
  let parts: ReturnType<typeof build>;

  beforeAll(async () => {
    parts = build(redis);
    await parts.queue.ensureConsumerGroup();
    server = createStatusServer({ redis, sampler: parts.sampler, metrics: parts.metrics, sampleIntervalMs: 60_000, targetSuccessRate: 0.9, dlqStream: K.dlq });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("criterion 1 + trust: job success rate and latency are tracked over time, each sample logged with a correlation ID", async () => {
    const logs = captureLogs();
    for (let i = 0; i < 3; i++) await parts.queue.enqueue({ id: `q${i}`, correlationId: `cq${i}`, idempotencyKey: `q${i}`, payload: {} });
    const enqueuedAt = Date.now() - 400;
    parts.tracker.observe({ event: "job_dequeued", correlationId: "c1", context: { jobId: "a", messageId: `${enqueuedAt}-0` } });
    parts.tracker.observe({ event: "job_processed", correlationId: "c1", context: { jobId: "a" } });
    parts.tracker.observe({ event: "job_failed", correlationId: "c2", context: { jobId: "b" } });

    const first = await parts.sampler.sampleOnce();
    expect(first).toMatchObject({ successRate: 0.5, processed: 1, failed: 1, queueDepth: 3, workers: 2, breakerTrips: null });
    expect(first!.p95LatencyMs).toBeGreaterThanOrEqual(400);
    const second = await parts.sampler.sampleOnce();
    expect(second).toMatchObject({ processed: 0, failed: 0 });

    const history = await parts.sampler.history(Date.now() - 60_000);
    expect(history.map((s) => s.sampleId)).toEqual([first!.sampleId, second!.sampleId]);
    const logged = logs().filter((l) => l.event === "metrics_sample");
    expect(logged.map((l) => l.correlationId)).toEqual([first!.sampleId, second!.sampleId]);
    expect(logged[0].context).toMatchObject({ successRate: 0.5, queueDepth: 3 });
  });

  it("criterion 2: a status request gets the plain-language view, and the JSON behind it", async () => {
    captureLogs();
    await parts.sampler.sampleOnce();
    const page = await fetch(`${baseUrl}/status`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await page.text();
    expect(html).toContain("needs attention"); // 50% success rate is below target
    expect(html).toContain("3 jobs are waiting to start.");

    const body = (await (await fetch(`${baseUrl}/status.json`)).json()) as { report: { state: string }; sample: { queueDepth: number } };
    expect(body.report.state).toBe("attention");
    expect(body.sample.queueDepth).toBe(3);

    const hist = (await (await fetch(`${baseUrl}/metrics/history?hours=1`)).json()) as { count: number };
    expect(hist.count).toBeGreaterThanOrEqual(3);
  });

  it("health: liveness has no dependencies; readiness checks Redis", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect(await (await fetch(`${baseUrl}/health/ready`)).json()).toEqual({ ok: true, redis: "reachable" });
  });

  it("is read-only: anything but GET is refused, unknown paths 404", async () => {
    expect((await fetch(`${baseUrl}/status`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/jobs`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${baseUrl}/admin`)).status).toBe(404);
  });

  it("serves the STORY-005 dashboard and its feed alongside", async () => {
    expect((await fetch(`${baseUrl}/dashboard`)).status).toBe(200);
    const metrics = (await (await fetch(`${baseUrl}/metrics`)).json()) as { totalRequests: number; dlqDepth: number | null };
    expect(metrics).toMatchObject({ totalRequests: 2, dlqDepth: 0 });
  });

  it("failure path, monitoring unavailable: sampling fails loudly, status says so (503), liveness stays up", async () => {
    const logs = captureLogs();
    const dead = new Redis({ port: 1, lazyConnect: true, retryStrategy: () => null, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    dead.on("error", () => {});
    const broken = build(dead);
    const brokenServer = createStatusServer({ redis: dead, sampler: broken.sampler, metrics: broken.metrics, sampleIntervalMs: 60_000, targetSuccessRate: 0.9, dlqStream: K.dlq });
    await new Promise<void>((resolve) => brokenServer.listen(0, resolve));
    const url = `http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}`;

    expect(await broken.sampler.sampleOnce()).toBeNull();
    expect(logs().find((l) => l.event === "monitoring_sample_failed")).toBeTruthy();
    const status = await fetch(`${url}/status.json`);
    expect(status.status).toBe(503);
    expect(((await status.json()) as { report: { state: string } }).report.state).toBe("down");
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/metrics/history`)).status).toBe(503);

    await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
    dead.disconnect();
  });

  it("history is capped so monitoring can't grow Redis without bound", async () => {
    captureLogs();
    const capped = new MonitoringSampler({ ...(parts.sampler as unknown as { deps: object }).deps, historyKey: `${K.history}:cap`, maxSamples: 5 } as never);
    for (let i = 0; i < 400; i++) await capped.sampleOnce();
    // MAXLEN ~ trims in whole radix-tree nodes, so "about" 5, never 400.
    expect(await redis.xlen(`${K.history}:cap`)).toBeLessThan(200);
    await redis.del(`${K.history}:cap`);
  });
});
