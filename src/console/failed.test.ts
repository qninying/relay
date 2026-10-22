// STORY-107 over HTTP against REAL Redis. Failed jobs are put on the DLQ
// with the real moveToDeadLetterQueue, and a resubmitted job is processed
// by the real worker loop. Covers the list (reason, class, time waited),
// resubmit with the original idempotency key, a job whose original already
// succeeded, discard with a required note (HTML kept as text), engineers
// only, two engineers at once, and the stream being unreadable. Skips
// cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { AuditLog } from "./audit.js";
import { FailedJobs } from "./failedJobs.js";
import { failedConsole, waited } from "./failedPages.js";
import { startConsole, type TestConsole } from "./testSupport.js";
import { RedisStreamQueue } from "../queue.js";
import { moveToDeadLetterQueue } from "../dlq.js";
import { RedisIdempotencyStore, InMemoryIdempotencyStore } from "../idempotencyStore.js";
import { runWorkerLoop } from "../workerLoop.js";
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
if (!redisAvailable) console.warn("[failed.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:failed:${RUN}:`;
const JOBS = `${P}jobs`;
const DLQ = `${JOBS}:dlq`;
const IDEM = `${JOBS}:idem:`;
const LATER = 3 * 60 * 60 * 1000 + 12 * 60 * 1000;

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = await redis.keys(`${P}*`);
  if (keys.length) await redis.del(...keys);
});

describe("waited", () => {
  it("says how long in plain units", () => {
    const t = Date.parse("2026-10-22T00:00:00Z");
    expect(waited("2026-10-22T00:00:00Z", t + 59_000)).toBe("0 min");
    expect(waited("2026-10-22T00:00:00Z", t + 45 * 60_000)).toBe("45 min");
    expect(waited("2026-10-22T00:00:00Z", t + LATER)).toBe("3 h 12 min");
    expect(waited("2026-10-22T00:00:00Z", t + 3 * 24 * 3600_000)).toBe("3 days");
    expect(waited("not a date", t)).toBe("unknown");
  });
});

describe.skipIf(!redisAvailable)("failed jobs (integration, real Redis, over HTTP)", () => {
  let c: TestConsole;
  const audit = new AuditLog(redis, `${P}audit`);
  const failed = new FailedJobs(redis, DLQ, JOBS, `${JOBS}:discarded`, IDEM);
  const dlq = new RedisStreamQueue(redis, DLQ, "relay-dlq");
  const work = new RedisStreamQueue(redis, JOBS, "relay-workers");

  beforeAll(async () => {
    await work.ensureConsumerGroup();
    c = await startConsole(redis, P, audit, [failedConsole({ failed, audit, now: () => Date.now() + LATER })], { eve: "engineer", fay: "engineer", ana: "analyst" });
  });
  afterAll(() => c.close());

  let n = 0;
  async function failJob(reason = "upstream returned 503 after 3 retries"): Promise<{ job: Job; entry: string }> {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    n += 1;
    const job: Job = { id: `job-${RUN}-${n}`, correlationId: `corr-${RUN}-${n}`, idempotencyKey: `key-${RUN}-${n}`, payload: { company: `Acme ${n}` } };
    await moveToDeadLetterQueue(dlq, job, reason);
    const entries = (await redis.xrange(DLQ, "-", "+")) as [string, string[]][];
    const entry = entries.find(([, f]) => JSON.parse(f[1]).id === job.id)![0];
    return { job, entry };
  }
  const queued = async (entry: string) => ((await redis.xrange(DLQ, entry, entry)) as unknown[]).length === 1;
  const workJobs = async () => ((await redis.xrange(JOBS, "-", "+")) as [string, string[]][]).map(([, f]) => JSON.parse(f[1]) as Job);
  const act = async (path: string, entry: string, who = "eve", extra: Record<string, string> = {}) => c.post(path, { ...(await c.formFields(`/console/failed/${entry}`, who === "ana" ? "eve" : who)), entry, ...extra }, who);

  it("criterion 1: the list shows each job's failure reason, class and how long it has waited", async () => {
    const { job, entry } = await failJob("upstream returned 503 after 3 retries");
    const list = await (await c.get("/console/failed")).text();
    expect(list).toContain(`<a href="/console/failed/${entry}">${job.id}</a></td><td>upstream returned 503 after 3 retries</td><td>upstream_error</td><td>3 h 12 min</td>`);
    const detail = await (await c.get(`/console/failed/${entry}`)).text();
    expect(detail).toContain(job.correlationId);
    expect(detail).toContain(job.idempotencyKey);
    expect(detail).toContain("Acme");
  });

  it("criterion 2: resubmitting enqueues the original job with its original idempotency key, leaves the list, is audited, and a real worker then runs it", async () => {
    const { job, entry } = await failJob();
    const res = await act("/console/failed/resubmit", entry);
    expect(res.status).toBe(303);
    expect(await queued(entry)).toBe(false);
    const again = (await workJobs()).filter((j) => j.id === job.id);
    expect(again).toEqual([{ id: job.id, correlationId: job.correlationId, idempotencyKey: job.idempotencyKey, payload: job.payload }]);
    const trail = (await audit.recent(50)).filter((e) => e.action === "failed.resubmit" && e.target.startsWith(job.id));
    expect(trail.map((e) => e.outcome).sort()).toEqual(["performed", "succeeded"]);
    expect(trail.find((e) => e.outcome === "succeeded")).toMatchObject({ operator: "eve", detail: `key ${job.idempotencyKey}` });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const controller = new AbortController();
    const loop = runWorkerLoop(work, new InMemoryIdempotencyStore(), { workerId: "w", correlationId: "t", signal: controller.signal, idlePollMs: 10, durableStore: new RedisIdempotencyStore(redis, IDEM) });
    const deadline = Date.now() + 5000;
    while (!(await redis.exists(`${IDEM}${job.idempotencyKey}`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await loop;
    expect(await redis.exists(`${IDEM}${job.idempotencyKey}`)).toBe(1);
  });

  it("failure path: a job whose original actually succeeded isn't resubmitted (its idempotency key is taken), and the page says so", async () => {
    const { job, entry } = await failJob();
    await redis.set(`${IDEM}${job.idempotencyKey}`, "1", "EX", 60);
    expect(await (await c.get(`/console/failed/${entry}`)).text()).toContain("has already completed, so resubmitting it would do nothing");
    const fields = await c.formFields("/console/failed", "eve").catch(() => null);
    expect(fields).toBeNull(); // the list page has no action form; take fields from a page that does
    const res = await c.post("/console/failed/resubmit", { ...(await c.formFields(`/console/failed/${entry}`)), entry });
    expect(res.status).toBe(409);
    expect(await queued(entry)).toBe(true);
    expect((await workJobs()).filter((j) => j.id === job.id)).toHaveLength(0);
    expect((await audit.recent(50)).find((e) => e.target === job.id && e.outcome === "rejected")).toMatchObject({ detail: "already_completed" });
  });

  it("criterion 3: discarding needs a note, then records who, why and when, leaves the list, and is audited; HTML in the note stays text", async () => {
    const { job, entry } = await failJob("HTTP 400: bad request");
    const noNote = await act("/console/failed/discard", entry, "eve", { note: "   " });
    expect(noNote.status).toBe(422);
    expect(await queued(entry)).toBe(true);

    const note = `<img src=x onerror=alert(1)> customer deleted`;
    expect((await act("/console/failed/discard", entry, "eve", { note })).status).toBe(303);
    expect(await queued(entry)).toBe(false);
    const [record] = await failed.recentDiscards(1);
    expect(record).toMatchObject({ jobId: job.id, by: "eve", note, failureReason: "HTTP 400: bad request" });
    const list = await (await c.get("/console/failed")).text();
    expect(list).toContain("&lt;img src=x onerror=alert(1)&gt; customer deleted");
    expect(list).not.toContain("<img src=x");
    // Every attempt that got past the form checks has an outcome: the refused one too.
    const trail = (await audit.recent(50)).filter((e) => e.action === "failed.discard" && e.target.startsWith(job.id));
    expect(trail.map((e) => e.outcome).sort()).toEqual(["performed", "performed", "rejected", "succeeded"]);
    expect(trail.find((e) => e.outcome === "rejected")!.detail).toBe("no_note");
    expect((await (await c.get("/console/audit", "eve")).text())).not.toContain("<img src=x");
  });

  it("trust: analysts see the page read-only, and a forged analyst post is refused and audited", async () => {
    const { job, entry } = await failJob();
    const pageHtml = await (await c.get(`/console/failed/${entry}`, "ana")).text();
    expect(pageHtml).toContain("Only engineers can resubmit or discard");
    expect(pageHtml).not.toContain('action="/console/failed/resubmit"');
    expect(pageHtml).not.toContain('action="/console/failed/discard"');
    const fields = await c.formFields("/console/failed", "ana").catch(() => null);
    expect(fields).toBeNull();
    // An analyst's own csrf token, taken from the sign-out form on any page.
    const csrf = pageHtml.match(/name="csrf" value="([^"]+)"/)![1];
    for (const path of ["/console/failed/resubmit", "/console/failed/discard"]) {
      expect((await c.post(path, { csrf, idem: `forged${RUN}abcdefghij`, entry, note: "x" }, "ana")).status).toBe(403);
    }
    expect(await queued(entry)).toBe(true);
    const refused = (await audit.recent(50)).filter((e) => e.operator === "ana" && e.target.startsWith(job.id));
    expect(refused).toHaveLength(2);
    for (const e of refused) expect(e).toMatchObject({ outcome: "rejected", detail: "role_analyst" });
  });

  it("trust: two engineers acting on the same job at once: exactly one action happens", async () => {
    const { job, entry } = await failJob();
    const [f1, f2] = await Promise.all([c.formFields(`/console/failed/${entry}`, "eve"), c.formFields(`/console/failed/${entry}`, "fay")]);
    const [a, b] = await Promise.all([
      c.post("/console/failed/resubmit", { ...f1, entry }, "eve"),
      c.post("/console/failed/discard", { ...f2, entry, note: "duplicate" }, "fay"),
    ]);
    expect([a.status, b.status].sort()).toEqual([303, 409]);
    const requeued = (await workJobs()).filter((j) => j.id === job.id).length;
    const discarded = (await failed.recentDiscards(20)).filter((d) => d.jobId === job.id).length;
    expect(requeued + discarded).toBe(1);
    expect(await queued(entry)).toBe(false);
  });

  it("trust: two engineers discarding the same job at once record one discard", async () => {
    const { job, entry } = await failJob();
    const [f1, f2] = await Promise.all([c.formFields(`/console/failed/${entry}`, "eve"), c.formFields(`/console/failed/${entry}`, "fay")]);
    const [a, b] = await Promise.all([
      c.post("/console/failed/discard", { ...f1, entry, note: "first" }, "eve"),
      c.post("/console/failed/discard", { ...f2, entry, note: "second" }, "fay"),
    ]);
    expect([a.status, b.status].sort()).toEqual([303, 409]);
    expect((await failed.recentDiscards(50)).filter((d) => d.jobId === job.id)).toHaveLength(1);
  });

  it("failure path: if the failed-jobs stream can't be read, the page says so (503) instead of showing an empty list; a failed action leaves the job in place", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { entry } = await failJob();
    const form = { ...(await c.formFields(`/console/failed/${entry}`)), entry };
    vi.spyOn(failed, "list").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const res = await c.get("/console/failed");
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("can't be read right now, so this isn't an empty list");
    expect(body).not.toContain("No failed jobs are waiting");
    vi.spyOn(failed, "get").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect((await c.get(`/console/failed/${entry}`)).status).toBe(503);
    vi.spyOn(failed, "resubmit").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect((await c.post("/console/failed/resubmit", form)).status).toBe(500);
    expect(await queued(entry)).toBe(true);
    // The form's key was released on failure, so the same click can be retried.
    expect((await c.post("/console/failed/resubmit", form)).status).toBe(303);
  });

  it("an entry without the original job can't be resubmitted but can be discarded; a decided job's page is 404; signed out redirects", async () => {
    const id = (await redis.xadd(DLQ, "*", "data", JSON.stringify({ id: `bare-${RUN}`, correlationId: "c", idempotencyKey: `bare-${RUN}`, payload: { failureReason: "unknown crash" } })))!;
    const pageHtml = await (await c.get(`/console/failed/${id}`)).text();
    expect(pageHtml).toContain("doesn't contain the original job");
    const form = { ...(await c.formFields(`/console/failed/${id}`)), entry: id };
    expect((await c.post("/console/failed/resubmit", form)).status).toBe(422);
    expect((await act("/console/failed/discard", id, "eve", { note: "nothing to rerun" })).status).toBe(303);
    expect((await c.get(`/console/failed/${id}`)).status).toBe(404);
    expect((await fetch(`${c.url}/console/failed`, { redirect: "manual" })).status).toBe(303);
  });

  it("lists more than a page with a Next link", async () => {
    for (let i = 0; i < 55; i++) await failJob();
    const first = await (await c.get("/console/failed")).text();
    expect((first.match(/<tr><td><a href="\/console\/failed\//g) ?? []).length).toBe(50);
    const next = first.match(/href="(\/console\/failed\?after=[0-9-]+)">Next/)![1];
    const second = await (await c.get(next)).text();
    expect((second.match(/<tr><td><a href="\/console\/failed\//g) ?? []).length).toBe((await failed.count()) - 50);
    expect(second).toContain("First page");
  });
});
