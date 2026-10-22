// STORY-104 over HTTP against REAL Redis: upload a CSV, see row errors before
// anything is queued, submit exactly once (double-click, two tabs, retry
// after a partial failure), audited with the batch id and row count, and
// every queued job carrying the batch id and its own correlation ID. Skips
// cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OperatorStore } from "./auth/operators.js";
import { SessionStore } from "./auth/sessions.js";
import { LoginLimiter } from "./auth/loginLimiter.js";
import { hashPassword } from "./auth/password.js";
import { generateTotpSecret, stepAt, totpCodeForStep } from "./auth/totp.js";
import { AuditLog } from "./audit.js";
import { ActionRunner } from "./actions.js";
import { BatchStore } from "./batches.js";
import { batchConsole } from "./batchPages.js";
import { createConsoleHandler, SESSION_COOKIE } from "./routes.js";
import { BatchResults } from "../batchResults.js";
import { RedisStreamQueue } from "../queue.js";
import { RedisIdempotencyStore, InMemoryIdempotencyStore } from "../idempotencyStore.js";
import { runWorkerLoop } from "../workerLoop.js";
import { standInClassifier } from "../classifierAdapter.js";
import type { Job } from "../processJob.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) console.warn("[batches.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:batchui:${RUN}:`;
const pw = "a-strong-test-pw";
const JOBS = `${P}jobs`;

// A queue that refuses writes after `failAfter` enqueues (Redis full), to
// exercise the resume path. null = never fails.
let failAfter: number | null = null;
let enqueued = 0;
const realQueue = new RedisStreamQueue(redis, JOBS, "g");
const flakyQueue = new Proxy(realQueue, {
  get(target, prop, receiver) {
    if (prop === "enqueue")
      return async (job: Job) => {
        if (failAfter !== null && enqueued >= failAfter) throw new Error("OOM command not allowed when used memory > 'maxmemory'");
        enqueued += 1;
        return target.enqueue(job);
      };
    return Reflect.get(target, prop, receiver);
  },
});

afterEach(() => vi.restoreAllMocks());
// Batch records live under relay:batch:<id> (the real prefix), so delete
// exactly the batches these tests created, plus everything under P.
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = [...(await redis.keys(`${P}*`))];
  for (const id of batchIds) keys.push(...(await redis.keys(`relay:batch:${id}:*`)));
  if (keys.length) await redis.del(...keys);
});
const batchIds: string[] = [];

describe.skipIf(!redisAvailable)("batch upload and submit (integration, real Redis, over HTTP)", () => {
  let url: string;
  let server: http.Server;
  const cookies: Record<string, string> = {};
  const audit = new AuditLog(redis, `${P}audit`);
  const results = new BatchResults(redis, "relay:batch:");

  beforeAll(async () => {
    await realQueue.ensureConsumerGroup();
    const operators = new OperatorStore(redis, `${P}op:`);
    const handler = createConsoleHandler({
      audit,
      actions: new ActionRunner(redis, audit, false, `${P}idem:`),
      extensions: [batchConsole({ store: new BatchStore(redis, P), results, queue: flakyQueue, audit })],
      operators,
      sessions: new SessionStore(redis, `${P}sess:`),
      limiter: new LoginLimiter(redis, { prefix: `${P}fail:` }),
      cookieSecure: false,
      trustProxy: false,
    });
    server = http.createServer((req, res) => void handler(req, res, new URL(req.url ?? "/", "http://localhost")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["ana", "bob"]) {
      const key = generateTotpSecret();
      await operators.create({ username: name, role: "analyst", passwordHash: await hashPassword(pw), totpKey: key });
      const res = await fetch(`${url}/console/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: name, password: pw, code: totpCodeForStep(key, stepAt(Date.now())) }).toString(),
        redirect: "manual",
      });
      cookies[name] = `${SESSION_COOKIE}=${res.headers.get("set-cookie")!.match(/relay_session=([^;]+)/)![1]}`;
    }
    vi.restoreAllMocks();
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = (path: string, who = "ana") => fetch(`${url}${path}`, { headers: { cookie: cookies[who] }, redirect: "manual" });
  async function formFields(path: string, who = "ana"): Promise<Record<string, string>> {
    const body = await (await get(path, who)).text();
    return { csrf: body.match(/name="csrf" value="([^"]+)"/)![1], idem: body.match(/name="idem" value="([^"]+)"/)![1] };
  }
  const post = (path: string, fields: Record<string, string>, who = "ana", headers: Record<string, string> = { origin: url }) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookies[who], ...headers }, body: new URLSearchParams(fields).toString(), redirect: "manual" });

  async function preview(csv: string, who = "ana", filename = "leads.csv") {
    const f = await formFields("/console/batches/new", who);
    const res = await post("/console/batches/preview", { ...f, csv, filename }, who);
    const body = await res.text();
    const submit = body.match(/name="csrf" value="([^"]+)"><input type="hidden" name="idem" value="([^"]+)">\s*<input type="hidden" name="draft" value="([0-9a-f]+)"/);
    return { res, body, submit: submit ? { csrf: submit[1], idem: submit[2], draft: submit[3] } : null };
  }
  const queueLength = () => redis.xlen(JOBS);
  const jobsFor = async (batchId: string) =>
    ((await redis.xrange(JOBS, "-", "+")) as [string, string[]][]).map(([, f]) => JSON.parse(f[1]) as Job).filter((j) => (j.payload as { batchId: string }).batchId === batchId);

  const CSV = `text,id\n${Array.from({ length: 10 }, (_, i) => (i === 3 ? "  ,x3" : i === 7 ? `${"q".repeat(2500)},x7` : `Company ${i} builds cloud software,x${i}`)).join("\n")}\n`;

  it("serves the upload page and its script from the console's own origin", async () => {
    const page = await get("/console/batches/new");
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('<script src="/console/assets/upload.js"></script>');
    expect(body).toContain("deleted 30 days after they're submitted");
    const js = await get("/console/assets/upload.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("criterion 1 + 2: preview shows which rows are wrong and why, and nothing is queued until submit", async () => {
    const before = await queueLength();
    const { res, body, submit } = await preview(CSV);
    expect(res.status).toBe(200);
    expect(body).toContain("<strong>8</strong> of 10 rows are ready from leads.csv. Nothing has been queued yet.");
    expect(body).toContain("<tr><td>4</td><td>the text is empty</td></tr>");
    expect(body).toContain("<tr><td>8</td><td>the text is 2,500 characters; the limit is 2,000</td></tr>");
    expect(body).toContain("Submit 8 rows as one batch");
    expect(submit).not.toBeNull();
    expect(await queueLength()).toBe(before);
  });

  it("criterion 1 + 3 + trust: submit queues each valid row once with the batch id and its own correlation ID, and is audited", async () => {
    const { submit } = await preview(CSV);
    const res = await post("/console/batches/submit", submit!);
    expect(res.status).toBe(303);
    const batchId = res.headers.get("location")!.split("/").pop()!;
    batchIds.push(batchId);
    const jobs = await jobsFor(batchId);
    expect(jobs).toHaveLength(8);
    expect(jobs.map((j) => (j.payload as { row: number }).row)).toEqual([1, 2, 3, 5, 6, 7, 9, 10]);
    for (const j of jobs) {
      expect(j.payload).toMatchObject({ batchId, text: expect.stringContaining("builds cloud software") });
      expect(j.idempotencyKey).toBe(`${batchId}-${(j.payload as { row: number }).row}`);
    }
    expect(new Set(jobs.map((j) => j.correlationId)).size).toBe(8);
    expect((jobs[0].payload as { ref: string }).ref).toBe("x0");

    const entry = (await audit.recent(100)).find((e) => e.action === "batch.submit" && e.target.startsWith(batchId));
    expect(entry).toMatchObject({ operator: "ana", target: `${batchId} (8 rows)`, outcome: "performed" });

    // Pressing submit again (same form) changes nothing.
    expect((await post("/console/batches/submit", submit!)).status).toBe(303);
    expect(await jobsFor(batchId)).toHaveLength(8);

    const detail = await (await get(`/console/batches/${batchId}`)).text();
    expect(detail).toContain("8 rows");
    expect(detail).toContain("<tr><th scope=\"row\">Waiting</th><td id=\"count-waiting\">8</td></tr>");
    expect(await (await get("/console/batches")).text()).toContain(batchId);
  });

  it("failure path, two tabs: the same check submitted from two forms at once is queued once", async () => {
    const { submit } = await preview(CSV);
    const second = { ...submit!, idem: `${submit!.idem}x` };
    const responses = await Promise.all([post("/console/batches/submit", submit!), post("/console/batches/submit", second)]);
    const location = responses.find((r) => r.status === 303)!.headers.get("location")!;
    const batchId = location.split("/").pop()!;
    batchIds.push(batchId);
    for (const r of responses) expect([303, 409, 410]).toContain(r.status);
    expect(await jobsFor(batchId)).toHaveLength(8);
  });

  it("failure path, Redis full mid-submit: the failure is reported, and retrying resumes without queuing anything twice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { submit } = await preview(CSV);
    enqueued = 0;
    failAfter = 3;
    const first = await post("/console/batches/submit", submit!);
    expect(first.status).toBe(500);
    const batchesPage = await (await get("/console/batches")).text();
    const batchId = batchesPage.match(/Submitting \(3 of 8 queued\)/) ? batchesPage.match(/href="\/console\/batches\/(b[0-9a-z]+)">\1<\/a><\/td><td>leads\.csv<\/td><td>8<\/td><td>ana<\/td><td>Submitting \(3 of 8 queued\)/)![1] : "";
    expect(batchId).not.toBe("");
    batchIds.push(batchId);
    expect(await jobsFor(batchId)).toHaveLength(3);
    expect(await (await get(`/console/batches/${batchId}`)).text()).toContain("Only 3 of 8 rows were queued");

    failAfter = null;
    const retry = await post("/console/batches/submit", submit!);
    expect(retry.status).toBe(303);
    const jobs = await jobsFor(batchId);
    expect(jobs).toHaveLength(8);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(8);
    expect((await audit.recent(200)).filter((e) => e.target.startsWith(batchId)).map((e) => e.outcome).sort()).toEqual(["failed", "performed", "performed"]);
  });

  it("a check can only be submitted by the operator who made it", async () => {
    const { submit } = await preview(CSV, "ana");
    const bobForm = await formFields("/console/batches/new", "bob");
    const before = await queueLength();
    const res = await post("/console/batches/submit", { ...bobForm, draft: submit!.draft }, "bob");
    expect(res.status).toBe(410);
    expect(await queueLength()).toBe(before);
  });

  it("refuses unusable files with a clear message, forged previews, and oversized uploads", async () => {
    const noText = await preview("name,id\nAcme,1\n");
    expect(noText.res.status).toBe(422);
    expect(noText.body).toContain("column named &quot;text&quot;");
    const allBad = await preview("text\n \n");
    expect(allBad.res.status).toBe(422);
    const f = await formFields("/console/batches/new");
    expect((await post("/console/batches/preview", { ...f, csv: CSV }, "ana", { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/console/batches/preview", { ...f, csv: "x".repeat(7 * 1024 * 1024) })).status).toBe(413);
  });

  it("end to end: a submitted batch is classified by the worker and the batch page shows the results", { timeout: 30_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { submit } = await preview("text\nAcme builds a SaaS platform\nRiverside runs outpatient clinics\nThe Corner Bakery\n");
    const res = await post("/console/batches/submit", submit!);
    const batchId = res.headers.get("location")!.split("/").pop()!;
    batchIds.push(batchId);
    const controller = new AbortController();
    const durableStore = new RedisIdempotencyStore(redis, `${P}widem:`);
    const loop = runWorkerLoop(realQueue, new InMemoryIdempotencyStore(), {
      workerId: "w",
      correlationId: "scale",
      signal: controller.signal,
      idlePollMs: 10,
      durableStore,
      batch: { classifier: standInClassifier, results, reviewStream: `${P}review`, durableStore },
    });
    const deadline = Date.now() + 10_000;
    while ((await results.counts(batchId)).recorded < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await loop;
    const detail = await (await get(`/console/batches/${batchId}`)).text();
    expect(detail).toContain('<tr><th scope="row">Done</th><td id="count-done">2</td></tr>');
    expect(detail).toContain('<tr><th scope="row">Waiting for review</th><td id="count-review">1</td></tr>');
    expect(detail).toContain('<tr><th scope="row">Waiting</th><td id="count-waiting">0</td></tr>');
  });
});
