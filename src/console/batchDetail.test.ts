// STORY-105 over HTTP against REAL Redis: live counts from a polled JSON
// endpoint, item lists and batch lists a page at a time (timed at 1,500
// batches and 5,000 items), the results CSV (one row per item, formulas
// neutralised, audited), audited views of someone else's batch, and polling
// that doesn't keep a session alive. Skips cleanly if Redis isn't reachable.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
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
import { BatchResults, type ItemOutcome } from "../batchResults.js";
import { RedisStreamQueue } from "../queue.js";
import { parseCsv } from "./csv.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) console.warn("[batchDetail.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");

const RUN = Math.random().toString(36).slice(2, 8);
const P = `relay:test:batchdetail:${RUN}:`;
const pw = "a-strong-test-pw";
const TTL_MS = 150;
const batchIds: string[] = [];

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const keys = [...(await redis.keys(`${P}*`))];
  for (const id of batchIds) keys.push(`relay:batch:${id}:meta`, `relay:batch:${id}:items`, `relay:batch:${id}:inputs`);
  for (let i = 0; i < keys.length; i += 1000) await redis.del(...keys.slice(i, i + 1000));
});

const at = "2026-10-22T00:00:00.000Z";
const outcome = (status: ItemOutcome["status"], label = "software"): ItemOutcome =>
  status === "failed" ? { status, reason: "classifier unavailable", at } : { status, label, confidence: status === "done" ? 0.91 : 0.4, taxonomyVersion: "industry.v1", at };

describe.skipIf(!redisAvailable)("batch progress, items and results download (integration, real Redis, over HTTP)", () => {
  let url: string;
  let server: http.Server;
  const cookies: Record<string, string> = {};
  const audit = new AuditLog(redis, `${P}audit`);
  const results = new BatchResults(redis, "relay:batch:");
  const store = new BatchStore(redis, P);
  const queue = new RedisStreamQueue(redis, `${P}jobs`, "g");

  beforeAll(async () => {
    await queue.ensureConsumerGroup();
    const operators = new OperatorStore(redis, `${P}op:`);
    const handler = createConsoleHandler({
      audit,
      actions: new ActionRunner(redis, audit, false, `${P}idem:`),
      // The shared 2-second count cache, shortened so tests can watch counts change.
      extensions: [batchConsole({ store, results, queue, audit, progressTtlMs: TTL_MS })],
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
    for (const name of ["ana", "bob"]) {
      const key = generateTotpSecret();
      await operators.create({ username: name, role: "analyst", passwordHash: await hashPassword(pw), totpKey: key });
      const res = await fetch(`${url}/console/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: name, password: pw, code: totpCodeForStep(key, stepAt(Date.now())) }).toString(),
        redirect: "manual",
      });
      cookies[name] = res.headers.get("set-cookie")!.match(/relay_session=([^;]+)/)![1];
    }
    vi.restoreAllMocks();
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = (path: string, who = "ana") => fetch(`${url}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${cookies[who]}` }, redirect: "manual" });
  const progress = async (batchId: string, who = "ana") => (await get(`/console/api/batches/${batchId}/progress`, who)).json();

  // A real submit (draft -> queue), so inputs are stored the way production stores them.
  async function submitBatch(texts: string[], operator = "ana") {
    const rows = texts.map((text, i) => ({ row: i + 1, text, ref: `r${i + 1}` }));
    const draft = await store.createDraft(operator, "leads.csv", rows, [], rows.length);
    batchIds.push(draft.batchId);
    await store.submit(draft, queue);
    return draft.batchId;
  }

  it("criterion 1: counts come from a polled JSON endpoint and change without reloading the page", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const batchId = await submitBatch(["Acme builds software", "Riverside clinic", "Corner bakery"]);
    const pageHtml = await (await get(`/console/batches/${batchId}`)).text();
    expect(pageHtml).toContain(`data-src="/console/api/batches/${batchId}/progress" data-finished="false"`);
    expect(pageHtml).toContain('<td id="count-waiting">3</td>');
    expect(pageHtml).toContain('<script src="/console/assets/progress.js"></script>');
    expect(pageHtml).toMatch(/kept until \d{4}-\d{2}-\d{2}, then deleted/);
    const js = await get("/console/assets/progress.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("document.hidden");

    expect(await progress(batchId)).toMatchObject({ done: 0, waiting: 3, review: 0, failed: 0, finished: false });
    await results.record(batchId, `${batchId}-1`, outcome("done"));
    await results.record(batchId, `${batchId}-2`, outcome("review"));
    await new Promise((r) => setTimeout(r, TTL_MS + 20));
    expect(await progress(batchId)).toMatchObject({ done: 1, waiting: 1, review: 1, failed: 0, finished: false });
    await results.record(batchId, `${batchId}-3`, outcome("failed"));
    await new Promise((r) => setTimeout(r, TTL_MS + 20));
    expect(await progress(batchId)).toMatchObject({ done: 1, waiting: 0, review: 1, failed: 1, recorded: 3, total: 3, finished: true });
    expect(await (await get(`/console/batches/${batchId}`)).text()).toContain('data-finished="true"');
  });

  it("failure path, many tabs: 40 simultaneous polls of one batch count it once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const batchId = await submitBatch(["a", "b"]);
    await new Promise((r) => setTimeout(r, TTL_MS + 20));
    const counts = vi.spyOn(results, "counts");
    const bodies = await Promise.all(Array.from({ length: 40 }, () => progress(batchId)));
    expect(bodies.every((b) => b.waiting === 2)).toBe(true);
    expect(counts).toHaveBeenCalledTimes(1);
  });

  it("criterion 2 + trust: the CSV has one row per item with input, label, confidence, status and taxonomy version, formulas neutralised, counts equal to item statuses, and the download is audited", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const texts = Array.from({ length: 120 }, (_, i) => (i === 0 ? '=HYPERLINK("http://evil.example","click")' : i === 1 ? "@SUM(A1:A9)" : i === 2 ? "Acme, Inc. builds software" : `Company ${i}`));
    const batchId = await submitBatch(texts);
    const statuses: ItemOutcome["status"][] = ["done", "review", "failed"];
    for (let row = 1; row <= 110; row++) await results.record(batchId, `${batchId}-${row}`, outcome(statuses[row % 3]));
    // A redelivered job can't add a second result.
    expect(await results.record(batchId, `${batchId}-1`, outcome("failed"))).toBe(false);

    const res = await get(`/console/batches/${batchId}/results.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="relay-${batchId}-results.csv"`);
    // A UTF-8 byte-order mark first, so Excel reads accented names correctly.
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    const [header, ...rows] = parseCsv(text);
    expect(header).toEqual(["row", "id", "input", "status", "label", "confidence", "taxonomy_version", "reason", "reviewed_by", "review_decision", "review_note", "model_label"]);
    expect(rows).toHaveLength(120);
    expect(rows.map((r) => r[0])).toEqual(texts.map((_, i) => String(i + 1)));
    expect(rows[0]).toEqual(["1", "r1", `'=HYPERLINK("http://evil.example","click")`, "waiting for review", "software", "0.4", "industry.v1", "", "", "", "", ""]);
    expect(rows[1][2]).toBe("'@SUM(A1:A9)");
    expect(rows[2]).toEqual(["3", "r3", "Acme, Inc. builds software", "done", "software", "0.91", "industry.v1", "", "", "", "", ""]);
    expect(rows[119][3]).toBe("waiting");

    // Trust: the counts are exactly the per-item statuses.
    const tally = { done: 0, review: 0, failed: 0, waiting: 0 };
    for (const r of rows) tally[({ done: "done", "waiting for review": "review", failed: "failed", waiting: "waiting" } as const)[r[3] as "done"]] += 1;
    await new Promise((r) => setTimeout(r, TTL_MS + 20));
    expect(await progress(batchId)).toMatchObject({ ...tally, recorded: 110, total: 120 });

    const entry = (await audit.recent(50)).find((e) => e.action === "batch.download" && e.target.startsWith(batchId));
    expect(entry).toMatchObject({ operator: "ana", target: `${batchId} (120 rows)`, outcome: "performed" });
  });

  it("failure path: if the audit log can't be written, the download is refused (503) rather than unaudited", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const batchId = await submitBatch(["x"]);
    vi.spyOn(audit, "record").mockRejectedValueOnce(new Error("OOM command not allowed"));
    const res = await get(`/console/batches/${batchId}/results.csv`);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).not.toContain("row,id,input");
  });

  it("failure path: another operator may open a batch, and that view is audited; the owner's own views aren't", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const batchId = await submitBatch(["x"], "ana");
    expect((await get(`/console/batches/${batchId}`, "ana")).status).toBe(200);
    expect((await get(`/console/batches/${batchId}`, "bob")).status).toBe(200);
    const views = (await audit.recent(50)).filter((e) => e.action === "batch.view" && e.target.startsWith(batchId));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ operator: "bob", target: `${batchId} (by ana)`, outcome: "performed" });

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(audit, "record").mockRejectedValueOnce(new Error("down"));
    expect((await get(`/console/batches/${batchId}`, "bob")).status).toBe(503);
  });

  it("the progress endpoint answers 401 without a session, 404 for an unknown batch, and polling doesn't extend the session", async () => {
    expect((await fetch(`${url}/console/api/batches/bnope000/progress`)).status).toBe(401);
    expect((await get("/console/api/batches/bnope000/progress")).status).toBe(404);
    const key = `${P}sess:${createHash("sha256").update(cookies.ana).digest("hex")}`;
    await redis.expire(key, 100);
    await get("/console/api/batches/bnope000/progress");
    expect(await redis.ttl(key)).toBeLessThanOrEqual(100);
    await get("/console");
    expect(await redis.ttl(key)).toBeGreaterThan(8 * 60 * 60 - 10);
  });

  it("retention: the batch record, inputs and results all expire together, and expired batches leave the list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const DAY = 24 * 60 * 60 * 1000;
    const short = new BatchStore(redis, `${P}ret:`, 5);
    const shortResults = new BatchResults(redis, "relay:batch:", 5);
    const rows = [{ row: 1, text: "Acme" }, { row: 2, text: "Riverside" }];
    const draft = await short.createDraft("ana", "r.csv", rows, [], 2);
    batchIds.push(draft.batchId);
    await short.submit(draft, queue);
    const near = (ms: number, target: number) => expect(Math.abs(ms - target)).toBeLessThan(60_000);
    near(await redis.pttl(`relay:batch:${draft.batchId}:meta`), 5 * DAY);
    near(await redis.pttl(`relay:batch:${draft.batchId}:inputs`), 5 * DAY);
    await shortResults.record(draft.batchId, `${draft.batchId}-1`, outcome("done"));
    near(await redis.pttl(`relay:batch:${draft.batchId}:items`), 5 * DAY);
    expect((await short.meta(draft.batchId))!.expiresAt).toBe(new Date(Date.parse((await short.meta(draft.batchId))!.createdAt) + 5 * DAY).toISOString());

    // Results for a batch with no record (expired, or not made in the console) still expire.
    const orphan = `borphan${RUN}`;
    batchIds.push(orphan);
    await shortResults.record(orphan, `${orphan}-1`, outcome("done"));
    near(await redis.pttl(`relay:batch:${orphan}:items`), 5 * DAY);

    // A batch older than the retention drops out of the index and the count.
    await redis.zadd(`${P}ret:batches`, Date.now() - 6 * DAY, "bstale0000");
    expect(await short.count()).toBe(1);
    expect(await redis.zscore(`${P}ret:batches`, "bstale0000")).toBeNull();
  });

  it("criterion 3: 1,500 batches and a 5,000-item batch render a page in under a second, with pagination", { timeout: 30_000 }, async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Seeded directly (a real submit of 5,000 rows is covered above at 120).
    const pipe = redis.pipeline();
    const now = Date.now();
    for (let i = 0; i < 1500; i++) {
      const id = `bt${RUN}${i.toString(36)}`;
      batchIds.push(id);
      pipe.hset(`relay:batch:${id}:meta`, "batchId", id, "operator", "ana", "filename", `f${i}.csv`, "total", "1", "queued", "1", "status", "submitted", "createdAt", new Date(now + i).toISOString());
      pipe.zadd(`${P}batches`, now + i, id);
    }
    const big = `bbig${RUN}`;
    batchIds.push(big);
    pipe.hset(`relay:batch:${big}:meta`, "batchId", big, "operator", "ana", "filename", "big.csv", "total", "5000", "queued", "5000", "status", "submitted", "createdAt", new Date(now + 2000).toISOString());
    pipe.zadd(`${P}batches`, now + 2000, big);
    const inputs: string[] = [];
    const items: string[] = [];
    for (let row = 1; row <= 5000; row++) {
      inputs.push(JSON.stringify({ row, text: `Company ${row} builds software for clinics and bakeries` }));
      if (row <= 4000) items.push(`${big}-${row}`, JSON.stringify(outcome(row % 10 === 0 ? "review" : "done")));
    }
    pipe.rpush(`relay:batch:${big}:inputs`, ...inputs);
    pipe.hset(`relay:batch:${big}:items`, ...items);
    await pipe.exec();

    const timed = async (path: string) => {
      const started = performance.now();
      const res = await get(path);
      const body = await res.text();
      return { res, body, ms: performance.now() - started };
    };
    const timings: Record<string, number> = {};

    const list1 = await timed("/console/batches");
    timings.list1 = list1.ms;
    expect(list1.body).toContain(big);
    expect(list1.body).toMatch(/Page 1 of (\d{2},?)+/);
    expect((list1.body.match(/<tr><td><a href="\/console\/batches\//g) ?? []).length).toBe(50);
    const listLast = await timed("/console/batches?page=999");
    timings.listLast = listLast.ms;
    expect(listLast.body).toContain("Previous");
    expect(listLast.body).not.toContain(">Next<");

    const detail1 = await timed(`/console/batches/${big}`);
    timings.detail1 = detail1.ms;
    expect(detail1.body).toContain('<td id="count-done">3,600</td>');
    expect(detail1.body).toContain('<td id="count-waiting">1,000</td>');
    expect(detail1.body).toContain("Page 1 of 100");
    const detail2 = await timed(`/console/batches/${big}?page=2`);
    expect(detail2.body).toContain("<tr><td>51</td>");
    expect(detail2.body).not.toContain("<tr><td>50</td>");
    const detailLast = await timed(`/console/batches/${big}?page=100`);
    timings.detailLast = detailLast.ms;
    expect(detailLast.body).toContain("<tr><td>5000</td>");
    expect(detailLast.body).toContain("<td>waiting</td>");
    expect((await timed(`/console/batches/${big}?page=abc`)).body).toContain("Page 1 of 100");

    const csv = await timed(`/console/batches/${big}/results.csv`);
    timings.csv5000 = csv.ms;
    expect(parseCsv(csv.body)).toHaveLength(5001);

    console.info(`[STORY-105 timings ms] ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])))}`);
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(1000);
  });
});

