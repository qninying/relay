// STORY-108 criterion 3 (REQ-112): every console screen, in real headless
// Chrome at 360px wide, in light and dark mode: no horizontal scroll, WCAG
// 2.1 AA contrast (text 1.4.3, field borders and chart lines 1.4.11),
// labels and structure, and full keyboard reach with a visible focus
// outline (see browserAudit.ts for exactly what is checked). Seeded with
// awkward data: a 2,000-character unbroken input, long ids and keys.
// Skips if Chrome or Redis isn't available.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import { AuditLog } from "./audit.js";
import { BatchStore } from "./batches.js";
import { batchConsole } from "./batchPages.js";
import { reviewConsole } from "./reviewPages.js";
import { ReviewItems } from "./reviewItems.js";
import { failedConsole } from "./failedPages.js";
import { FailedJobs } from "./failedJobs.js";
import { overviewConsole } from "./overview.js";
import { startConsole, type TestConsole } from "./testSupport.js";
import { Browser, CHROME, auditPage } from "./browserAudit.js";
import { BatchResults } from "../batchResults.js";
import { RedisStreamQueue } from "../queue.js";
import { RedisIdempotencyStore } from "../idempotencyStore.js";
import { handleBatchItem } from "../batchWorker.js";
import { cachedTaxonomy } from "../classifyJob.js";
import { moveToDeadLetterQueue } from "../dlq.js";
import type { MetricsSample } from "../monitoringSampler.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
const chrome = existsSync(CHROME);
if (!redisAvailable || !chrome) console.warn(`[a11y.test.ts] skipped: ${!chrome ? "Chrome not installed" : "Redis not reachable"}.`);

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:a11y:${RUN}:`;
const batchIds: string[] = [];

afterAll(async () => {
  if (!redisAvailable) return;
  const keys = [...(await redis.keys(`${P}*`))];
  for (const id of batchIds) keys.push(`relay:batch:${id}:meta`, `relay:batch:${id}:items`, `relay:batch:${id}:inputs`);
  if (keys.length) await redis.del(...keys);
});

describe.skipIf(!redisAvailable || !chrome)("console accessibility in real Chrome (360px, light and dark)", () => {
  let c: TestConsole;
  let browser: Browser;
  const paths: string[] = ["/console", "/console/batches", "/console/batches/new", "/console/review", "/console/failed", "/console/audit", "/console/nope"];

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const audit = new AuditLog(redis, `${P}audit`);
    const results = new BatchResults(redis, "relay:batch:");
    const store = new BatchStore(redis, P);
    const queue = new RedisStreamQueue(redis, `${P}jobs`, "g");
    await queue.ensureConsumerGroup();
    const now = Date.now();
    const samples: MetricsSample[] = [];
    for (let t = now - 24 * 3_600_000; t < now; t += 60_000) {
      if (t > now - 6 * 3_600_000 && t < now - 4 * 3_600_000) continue;
      samples.push({ sampleId: "s", at: new Date(t).toISOString(), intervalMs: 60_000, successRate: 0.97, p95LatencyMs: 1500, windowJobs: 200, processed: 3, failed: t % 7 === 0 ? 2 : 0, movedToDlq: 0, dlqDepth: 1, routedToReview: 0, reviewDepth: 1, queueDepth: 5, pending: 0, workers: 2, breakerTrips: null });
    }
    const failed = new FailedJobs(redis, `${P}jobs:dlq`, `${P}jobs`, `${P}jobs:discarded`, `${P}jobs:idem:`);
    c = await startConsole(
      redis,
      P,
      audit,
      [
        overviewConsole({ latest: () => ({ sample: samples[samples.length - 1], error: null }), history: async () => samples, sampleIntervalMs: 60_000, targetSuccessRate: 0.9 }),
        batchConsole({ store, results, queue, audit }),
        reviewConsole({ items: new ReviewItems(redis, `${P}review`), results, audit, getTaxonomy: cachedTaxonomy() }),
        failedConsole({ failed, audit }),
      ],
      { eve: "engineer" }
    );

    // A batch with awkward content, some done, one in review.
    const long = "x".repeat(2000);
    const rows = [{ row: 1, text: long, ref: "ref-" + "9".repeat(90) }, { row: 2, text: "Acme builds SaaS software" }, { row: 3, text: "The Corner Bakery" }];
    const draft = await store.createDraft("eve", `${"very-long-file-name-".repeat(8)}.csv`, rows, [], 3);
    batchIds.push(draft.batchId);
    await store.submit(draft, queue);
    const deps = { classifier: async ({ text }: { text: string }) => ({ label: text.includes("SaaS") ? "software" : "other", confidence: text.includes("SaaS") ? 0.9 : 0.3 }), results, reviewStream: `${P}review`, durableStore: new RedisIdempotencyStore(redis, `${P}widem:`) };
    for (const r of rows) await handleBatchItem({ id: `${draft.batchId}-${r.row}`, correlationId: `c${r.row}`, idempotencyKey: `${draft.batchId}-${r.row}`, payload: { batchId: draft.batchId, text: r.text, row: r.row } }, { batchId: draft.batchId, text: r.text }, deps);
    const review = ((await redis.xrange(`${P}review`, "-", "+")) as [string, string[]][])[0][0];
    await moveToDeadLetterQueue(new RedisStreamQueue(redis, `${P}jobs:dlq`, "d"), { id: "job-" + "z".repeat(80), correlationId: "corr-1", idempotencyKey: "key-" + "k".repeat(120), payload: { company: long } }, "upstream returned 503 after 3 retries");
    const dead = ((await redis.xrange(`${P}jobs:dlq`, "-", "+")) as [string, string[]][])[0][0];
    paths.push(`/console/batches/${draft.batchId}`, `/console/review/${review}`, `/console/failed/${dead}`);
    vi.restoreAllMocks();

    browser = await Browser.launch();
    await browser.setCookie("relay_session", c.sessionId("eve"), c.url);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await c?.close();
  });

  it("criterion 3: every screen passes at 360px in light and dark mode", { timeout: 180_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const problems: string[] = [];
    let checked = 0;
    for (const scheme of ["light", "dark"] as const) {
      await browser.viewport(360, scheme);
      for (const path of ["/console/login", ...paths]) {
        await browser.goto(`${c.url}${path}`);
        for (const p of await auditPage(browser)) problems.push(`${scheme} ${path}: ${p}`);
        checked += 1;
      }
      // The upload check page (a POST result) with row errors.
      await browser.goto(`${c.url}/console/batches/new`);
      await browser.navigateBy(`document.getElementById("csv").value = "text,id\\n,x1\\n${"y".repeat(2100)},x2\\nAcme,x3\\n"; document.querySelector('form[action="/console/batches/preview"]').submit(); true`);
      expect(await browser.evaluate<string>("document.querySelector('h1') && document.querySelector('h1').textContent")).toBe("Check before submitting");
      for (const p of await auditPage(browser)) problems.push(`${scheme} preview: ${p}`);
      checked += 1;
    }
    console.info(`[STORY-108 a11y] ${checked} page renders checked; problems: ${problems.length}`);
    expect(problems).toEqual([]);
  });

  it("a real browser's own form posts pass the same-origin check: upload, submit an audited action, sign out", { timeout: 60_000 }, async () => {
    const h1 = () => browser.evaluate<string>("document.querySelector('h1').textContent");
    await browser.viewport(360, "light");
    await browser.goto(`${c.url}/console/batches/new`);
    await browser.navigateBy(`document.getElementById("csv").value = "text\\nAcme builds SaaS software\\n"; document.querySelector('form[action="/console/batches/preview"]').submit(); true`);
    expect(await h1()).toBe("Check before submitting");
    await browser.navigateBy(`document.querySelector('form[action="/console/batches/submit"]').submit(); true`);
    expect(await h1()).toMatch(/^Batch b[0-9a-z]+$/);
    batchIds.push((await h1()).slice(6));
    await browser.navigateBy(`document.querySelector('form[action="/console/logout"]').submit(); true`);
    expect(await h1()).toBe("Sign in");
  });
});
