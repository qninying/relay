// STORY-108 over HTTP against REAL Redis: the console home shows the
// plain-language status and 24-hour charts built from the real monitoring
// history stream; stale or unavailable monitoring is said in words; gaps
// stay gaps; a week of samples stays fast (and /metrics/history returns
// all of it); the public /status page needs no login and shows no job
// content. Skips cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { AuditLog } from "./audit.js";
import { overviewConsole, type OverviewDeps } from "./overview.js";
import { startConsole, type TestConsole } from "./testSupport.js";
import { createConsoleHandler } from "./routes.js";
import { MonitoringSampler, type MetricsSample } from "../monitoringSampler.js";
import { RedisStreamQueue } from "../queue.js";
import { MetricsCollector } from "../metrics.js";
import { JobOutcomeTracker } from "../jobOutcomeTracker.js";
import { createStatusServer } from "../statusServer.js";
import { ActionRunner } from "./actions.js";
import { OperatorStore } from "./auth/operators.js";
import { SessionStore } from "./auth/sessions.js";
import { LoginLimiter } from "./auth/loginLimiter.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) console.warn("[overview.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:overview:${RUN}:`;
const HISTORY = `${P}metrics`;
const WEEK = `${P}metrics-week`;
const MIN = 60_000;

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = await redis.keys(`${P}*`);
  if (keys.length) await redis.del(...keys);
});

function sample(at: number, over: Partial<MetricsSample> = {}): MetricsSample {
  return { sampleId: `s${at}`, at: new Date(at).toISOString(), intervalMs: MIN, successRate: 0.98, p95LatencyMs: 1200, windowJobs: 200, processed: 5, failed: 1, movedToDlq: 0, dlqDepth: 0, routedToReview: 0, reviewDepth: 0, queueDepth: 4, pending: 0, workers: 2, breakerTrips: null, ...over };
}

// Writes one sample a minute into a history stream with time-based ids, as the sampler does.
async function seed(key: string, from: number, to: number, skip?: [number, number]): Promise<number> {
  let n = 0;
  let pipe = redis.pipeline();
  for (let t = from; t < to; t += MIN) {
    if (skip && t >= skip[0] && t < skip[1]) continue;
    pipe.xadd(key, `${t}-0`, "sample", JSON.stringify(sample(t)));
    n += 1;
    if (n % 2000 === 0) {
      await pipe.exec();
      pipe = redis.pipeline();
    }
  }
  await pipe.exec();
  return n;
}

function sampler(historyKey: string): MonitoringSampler {
  const queue = new RedisStreamQueue(redis, `${P}jobs`, "g");
  const metrics = new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.9 });
  return new MonitoringSampler({ redis, queue, queueStream: `${P}jobs`, queueGroup: "g", dlqStream: `${P}dlq`, reviewStream: `${P}review`, metrics, tracker: new JobOutcomeTracker(metrics), workerCount: () => 2, historyKey });
}

describe.skipIf(!redisAvailable)("overview (integration, real Redis, over HTTP)", () => {
  let c: TestConsole;
  const audit = new AuditLog(redis, `${P}audit`);
  const now = Date.now();
  const outage: [number, number] = [now - 6 * 3_600_000, now - 4 * 3_600_000];
  let latest: ReturnType<OverviewDeps["latest"]> = { sample: sample(now - 30_000), error: null };
  let history: OverviewDeps["history"];
  const real = () => sampler(HISTORY);

  beforeAll(async () => {
    await seed(HISTORY, now - 24 * 3_600_000, now, outage);
    history = (since) => real().history(since);
    c = await startConsole(redis, P, audit, [overviewConsole({ latest: () => latest, history: (s) => history(s), sampleIntervalMs: MIN, targetSuccessRate: 0.9, historyTimeoutMs: 300 })], { ana: "analyst" });
  });
  afterAll(() => c.close());

  it("criterion 1: the home page is the plain-language status plus 24-hour charts of success rate, p95 latency, queue depth and failed jobs", async () => {
    const started = performance.now();
    const res = await c.get("/console");
    const body = await res.text();
    const ms = performance.now() - started;
    expect(res.status).toBe(200);
    expect(body).toContain("<h1>Relay is running normally.</h1>");
    expect(body).toContain('<span aria-hidden="true" class="state-symbol">✓</span> Running normally');
    for (const title of ["Success rate", "Slowest 5% of jobs (p95)", "Jobs waiting to start", "Failed jobs"]) expect(body).toContain(`${title}, last 24 hours</title>`);
    expect((body.match(/role="img"/g) ?? []).length).toBe(4);
    // The 2-hour outage is 4 shaded half-hours on each chart (5 if the edges straddle a bucket).
    const gaps = (body.match(/class="gap"/g) ?? []).length / 4;
    expect(gaps).toBeGreaterThanOrEqual(3);
    expect(gaps).toBeLessThanOrEqual(5);
    expect(body).toContain("Show the numbers");
    expect(body).toContain('<nav class="site" aria-label="Console">');
    console.info(`[STORY-108 timings ms] overview with 24h of samples: ${Math.round(ms)}`);
    expect(ms).toBeLessThan(1000);
  });

  it("criterion 2: stale monitoring is said first, in words, not shown as current", async () => {
    latest = { sample: sample(now - 10 * MIN), error: null };
    try {
      const body = await (await c.get("/console")).text();
      expect(body).toContain("<h1>Relay&#39;s status is out of date.</h1>");
      expect(body).toMatch(/<p class="error" role="alert">These numbers are about 10 minutes old: the monitor has stopped updating/);
      expect(body).toContain('class="state-symbol">?</span> Unknown');
    } finally {
      latest = { sample: sample(now - 30_000), error: null };
    }
  });

  it("criterion 2: monitoring unavailable shows no numbers as current", async () => {
    latest = { sample: sample(now - 30_000), error: { at: new Date(now - 20_000).toISOString(), errorClass: "MaxRetriesPerRequestError" } };
    try {
      const body = await (await c.get("/console")).text();
      expect(body).toContain("<h1>Relay can&#39;t reach its job queue right now.</h1>");
      expect(body).toContain("no numbers are shown rather than old ones");
      expect(body).not.toContain("of the last 200 jobs succeeded");
    } finally {
      latest = { sample: sample(now - 30_000), error: null };
    }
  });

  it("failure path: history that errors or hangs is replaced by a sentence, and the status still shows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const saved = history;
    try {
      history = async () => {
        throw new Error("connect ECONNREFUSED");
      };
      let body = await (await c.get("/console")).text();
      expect(body).toContain("The 24-hour history can't be read right now");
      expect(body).toContain("<h1>Relay is running normally.</h1>");
      history = () => new Promise(() => {});
      const started = Date.now();
      body = await (await c.get("/console")).text();
      expect(Date.now() - started).toBeLessThan(1500);
      expect(body).toContain("The 24-hour history can't be read right now");
    } finally {
      history = saved;
    }
  });

  it("failure path: a week of samples: the overview still reads only a day and stays fast, and /metrics/history?hours=168 returns all of it", { timeout: 60_000 }, async () => {
    const count = await seed(WEEK, now - 7 * 24 * 3_600_000, now);
    const week = sampler(WEEK);
    const started = performance.now();
    const day = await week.history(now - 24 * 3_600_000);
    const dayMs = performance.now() - started;
    expect(day.length).toBe(24 * 60);

    const status = createStatusServer({ redis, sampler: week, metrics: new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.9 }), sampleIntervalMs: MIN, targetSuccessRate: 0.9, dlqStream: `${P}dlq` });
    await new Promise<void>((resolve) => status.listen(0, "127.0.0.1", resolve));
    try {
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${(status.address() as AddressInfo).port}/metrics/history?hours=168`);
      const bodyJson = (await res.json()) as { count: number; samples: MetricsSample[] };
      const weekMs = performance.now() - t0;
      // The server's "7 days ago" is a few ms later than the seed's start, so the very first sample may fall outside.
      expect(bodyJson.count).toBeGreaterThanOrEqual(count - 1);
      expect(bodyJson.count).toBeGreaterThan(2000);
      // Oldest and newest both present: not cut to the first 2,000.
      expect(Date.parse(bodyJson.samples[bodyJson.samples.length - 1].at)).toBeGreaterThan(now - 2 * MIN);
      console.info(`[STORY-108 timings ms] 24h history read: ${Math.round(dayMs)}; 7-day /metrics/history (${count} samples): ${Math.round(weekMs)}`);
      expect(dayMs).toBeLessThan(1000);
      expect(weekMs).toBeLessThan(3000);
    } finally {
      await new Promise<void>((resolve) => status.close(() => resolve()));
    }
  });

  it("trust: the public /status page needs no login and shows no job content, while /console still requires sign-in", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const marker = `JOB-CONTENT-MARKER-${RUN}`;
    await redis.xadd(`${P}jobs`, "*", "data", JSON.stringify({ id: "j", correlationId: "c", idempotencyKey: "k", payload: { text: marker } }));
    await redis.xadd(`${P}review`, "*", "data", JSON.stringify({ id: "r", correlationId: "c", idempotencyKey: "r", payload: { originalPayload: { text: marker } } }));
    await redis.xadd(`${P}dlq`, "*", "data", JSON.stringify({ id: "d", correlationId: "c", idempotencyKey: "d", payload: { originalPayload: { text: marker }, failureReason: marker } }));
    const s = sampler(`${P}metrics-trust`);
    await new RedisStreamQueue(redis, `${P}jobs`, "g").ensureConsumerGroup();
    await s.sampleOnce();
    const consoleHandler = createConsoleHandler({
      audit,
      actions: new ActionRunner(redis, audit, false, `${P}idem2:`),
      operators: new OperatorStore(redis, `${P}op2:`),
      sessions: new SessionStore(redis, `${P}sess2:`),
      limiter: new LoginLimiter(redis, { prefix: `${P}fail2:` }),
      cookieSecure: false,
      trustProxy: false,
    });
    const status = createStatusServer({ redis, sampler: s, metrics: new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.9 }), sampleIntervalMs: MIN, targetSuccessRate: 0.9, dlqStream: `${P}dlq`, console: consoleHandler });
    await new Promise<void>((resolve) => status.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(status.address() as AddressInfo).port}`;
    try {
      for (const path of ["/status", "/status.json", "/metrics/history?hours=1"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain(marker);
      }
      expect(await (await fetch(`${base}/status`)).text()).toContain("1 job failed after every retry");
      expect((await fetch(`${base}/console`, { redirect: "manual" })).status).toBe(303);
    } finally {
      await new Promise<void>((resolve) => (status as http.Server).close(() => resolve()));
    }
  });
});
