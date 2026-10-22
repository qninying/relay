// STORY-009 against REAL Redis and REAL worker processes: ack-after-
// processing and reclaim (no loss when a worker dies mid-job), the shared
// idempotency store (no duplicates on redelivery), poison messages, and the
// chaos drill itself. Skips cleanly if Redis isn't reachable.

import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";
import { RedisStreamQueue } from "./queue.js";
import { RedisIdempotencyStore, InMemoryIdempotencyStore } from "./idempotencyStore.js";
import { processJobDurable, type Job } from "./processJob.js";
import { runWorkerLoop } from "./workerLoop.js";
import { runChaosDrill, ChaosDrillRefusedError, type WorkerLine } from "./chaosDrill.js";

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
  console.warn("[chaos.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");
}

const RUN = Math.random().toString(36).slice(2, 8);
const workerEntry = fileURLToPath(new URL("./workerProcess.ts", import.meta.url));
const created: string[] = [];
function keys(name: string) {
  const k = { stream: `relay:test:chaos:${RUN}:${name}`, dlq: `relay:test:chaos:${RUN}:${name}:dlq`, idem: `relay:test:chaos:${RUN}:${name}:idem:` };
  created.push(k.stream, k.dlq);
  return k;
}
function job(id: string): Job {
  return { id, correlationId: `corr-${id}`, idempotencyKey: `${RUN}-${id}`, payload: {} };
}
function captureLogs() {
  const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return () => spies.flatMap((s) => s.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, any>));
}
async function pending(stream: string, group: string): Promise<number> {
  return Number(((await redis.xpending(stream, group)) as [number])[0]);
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const idem = await redis.keys(`relay:test:chaos:${RUN}:*`);
  await redis.del(...new Set([...created, ...idem]));
});

describe.skipIf(!redisAvailable)("ack after processing + reclaim (integration, real Redis)", () => {
  it("a message read but never acked (worker died) stays pending, and is reclaimed by another consumer with its delivery count", async () => {
    const logs = captureLogs();
    const k = keys("reclaim");
    const q = new RedisStreamQueue(redis, k.stream, "g");
    await q.ensureConsumerGroup();
    await q.enqueue(job("r1"));

    const first = await q.readNew("worker-a");
    expect(first).toMatchObject({ job: { id: "r1" }, deliveryCount: 1 });
    expect(await pending(k.stream, "g")).toBe(1); // not acked: not lost

    expect(await q.reclaimStale("worker-b", 60_000)).toEqual([]); // not idle long enough yet
    await new Promise((r) => setTimeout(r, 30));
    const reclaimed = await q.reclaimStale("worker-b", 20);
    expect(reclaimed).toMatchObject([{ job: { id: "r1" }, messageId: first!.messageId, deliveryCount: 2 }]);
    expect(logs().find((l) => l.event === "job_reclaimed")).toMatchObject({ correlationId: "corr-r1", context: { consumer: "worker-b", deliveryCount: 2 } });

    await q.ack(reclaimed[0].messageId);
    expect(await pending(k.stream, "g")).toBe(0);
  });

  it("crash after processing but before ack: the reclaimed job is skipped as a duplicate, not processed twice", async () => {
    const logs = captureLogs();
    const k = keys("crash-after-claim");
    const q = new RedisStreamQueue(redis, k.stream, "g");
    await q.ensureConsumerGroup();
    const durable = new RedisIdempotencyStore(redis, k.idem);
    await q.enqueue(job("c1"));

    // Worker A processes the job, then "dies" before acking.
    const delivery = await q.readNew("worker-a");
    expect(await processJobDurable(delivery!.job, durable)).toEqual({ status: "processed" });

    // Worker B (separate in-memory store, like a separate process) reclaims it.
    const controller = new AbortController();
    const loop = runWorkerLoop(q, new InMemoryIdempotencyStore(), {
      workerId: "worker-b",
      correlationId: "scale-b",
      signal: controller.signal,
      durableStore: durable,
      reclaimIdleMs: 20,
      idlePollMs: 10,
    });
    const deadline = Date.now() + 5000;
    while ((await pending(k.stream, "g")) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await loop;

    const events = logs().filter((l) => l.correlationId === "corr-c1").map((l) => l.event);
    expect(events.filter((e) => e === "job_processed")).toHaveLength(1);
    expect(events).toContain("job_reclaimed");
    expect(events).toContain("job_skipped_duplicate");
    expect(await pending(k.stream, "g")).toBe(0);
  });

  it("a poison message (delivered more than maxDeliveries times) goes to the DLQ instead of crashing workers forever", async () => {
    const logs = captureLogs();
    const k = keys("poison");
    const q = new RedisStreamQueue(redis, k.stream, "g");
    const dlq = new RedisStreamQueue(redis, k.dlq, "g");
    await q.ensureConsumerGroup();
    await q.enqueue(job("p1"));
    await q.readNew("worker-a"); // delivery 1, never acked

    const controller = new AbortController();
    const loop = runWorkerLoop(q, new InMemoryIdempotencyStore(), {
      workerId: "worker-b",
      correlationId: "scale-b",
      signal: controller.signal,
      dlq,
      maxDeliveries: 1,
      reclaimIdleMs: 0,
      idlePollMs: 10,
    });
    const deadline = Date.now() + 5000;
    while ((await redis.xlen(k.dlq)) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await loop;

    expect(await redis.xlen(k.dlq)).toBe(1);
    expect(await pending(k.stream, "g")).toBe(0);
    expect(logs().find((l) => l.event === "job_moved_to_dlq")).toMatchObject({ correlationId: "corr-p1", context: { failureReason: "max_deliveries_exceeded: delivered 2 times" } });
    expect(logs().some((l) => l.event === "job_processed" && l.correlationId === "corr-p1")).toBe(false);
  });

  it("the shared idempotency store claims a key exactly once across connections, with an expiry", async () => {
    const k = keys("idem");
    const other = new Redis({ lazyConnect: true, retryStrategy: () => null });
    await other.connect();
    const a = new RedisIdempotencyStore(redis, k.idem);
    const b = new RedisIdempotencyStore(other, k.idem);
    const results = await Promise.all([a.claim("x"), b.claim("x"), a.claim("x"), b.claim("x")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await redis.ttl(`${k.idem}x`)).toBeGreaterThan(0);
    other.disconnect();
  });

  it("a failing idempotency store fails the job rather than processing it unguarded", async () => {
    captureLogs();
    const result = await processJobDurable(job("f1"), { claim: () => Promise.reject(new Error("ECONNRESET")) });
    expect(result).toEqual({ status: "failed", errorClass: "Error" });
  });
});

describe.skipIf(!redisAvailable)("the chaos drill (integration, real worker processes)", () => {
  it("criteria 1-3: SIGKILLs mid-job, a forced backlog with duplicate enqueues, zero loss, zero duplicates, all logged", async () => {
    const logs = captureLogs();
    const workerLines: WorkerLine[] = [];
    const report = await runChaosDrill(redis, workerEntry, {
      jobs: 60,
      duplicateEnqueues: 10,
      workers: 3,
      kills: 2,
      simulatedWorkMs: 40,
      reclaimIdleMs: 500,
      timeoutMs: 30_000,
      onWorkerLine: (workerId, line) => workerLines.push({ workerId, line }),
    });

    // Criterion 1: workers killed mid-job, system recovered, no data lost.
    expect(report.killed).toHaveLength(2);
    for (const k of report.killed) expect(k.recoveredElsewhere).toBe(true);
    expect(report.lost).toEqual([]);
    expect(report.pendingAfter).toBe(0);
    // Criterion 2: forced backlog (with producer retries) processed without duplicates.
    expect(report.duplicates).toEqual([]);
    expect(report.processedOnce).toBe(60);
    expect(report.skippedAsDuplicate).toBeGreaterThanOrEqual(10);
    expect(report).toMatchObject({ passed: true, failures: [], dlqDepth: 0 });

    // Criterion 3: drill events carry the drill's correlation ID...
    const drillEvents = logs().filter((l) => l.correlationId === report.drillId).map((l) => l.event);
    expect(drillEvents).toEqual(expect.arrayContaining(["chaos_drill_started", "chaos_backlog_forced", "chaos_fault_injected", "chaos_worker_replaced", "chaos_drill_completed"]));
    expect(drillEvents.filter((e) => e === "chaos_fault_injected")).toHaveLength(2);
    // ...and each recovered job's trail keeps its own correlation ID across workers.
    const recoveredJob = report.killed[0].inFlightJobId!;
    const trail = workerLines.filter((w) => (w.line.context as { jobId?: string })?.jobId === recoveredJob);
    expect(new Set(trail.map((w) => w.line.correlationId))).toEqual(new Set([recoveredJob]));
    expect(new Set(trail.map((w) => w.workerId)).size).toBeGreaterThan(1);

    // The drill cleaned up after itself.
    expect(await redis.keys(`relay:chaos:${report.drillId}*`)).toEqual([]);
  }, 60_000);

  it("refuses to run against a non-local Redis, and logs the refusal", async () => {
    const logs = captureLogs();
    const remote = new Redis({ host: "10.0.0.99", lazyConnect: true, retryStrategy: () => null });
    remote.on("error", () => {});
    await expect(
      runChaosDrill(remote, workerEntry, { jobs: 1, duplicateEnqueues: 0, workers: 1, kills: 0, simulatedWorkMs: 0, reclaimIdleMs: 100, timeoutMs: 1000 })
    ).rejects.toBeInstanceOf(ChaosDrillRefusedError);
    expect(logs().find((l) => l.event === "chaos_drill_refused")).toMatchObject({ context: { host: "10.0.0.99" } });
    remote.disconnect();
  });
});
