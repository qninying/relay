// STORY-006 end to end against REAL Redis and REAL worker OS processes: a
// burst of jobs lands on the stream, the autoscaler forks workers to match,
// the workers drain the backlog, and the autoscaler scales back down. Skips
// cleanly if Redis isn't reachable (run `docker compose up -d redis`).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";
import { RedisStreamQueue, BacklogUnknownError } from "./queue.js";
import { ProcessWorkerPool } from "./processWorkerPool.js";
import { Autoscaler } from "./autoscaler.js";

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
  console.warn("[autoscaler.integration.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");
}

const workerEntry = fileURLToPath(new URL("./workerProcess.ts", import.meta.url));
const stubbornEntry = fileURLToPath(new URL("./testFixtures/stubbornWorker.mjs", import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe.skipIf(!redisAvailable)("autoscaling real worker processes (integration, real Redis)", () => {
  const streamKey = `relay:test:autoscale:${Math.random().toString(36).slice(2)}`;
  const groupName = "relay-autoscale-group";
  const queue = new RedisStreamQueue(redis, streamKey, groupName);
  const workerLines: Array<{ workerId: string; line: Record<string, unknown> }> = [];
  const pool = new ProcessWorkerPool({
    entryPath: workerEntry,
    streamKey,
    groupName,
    stopGraceMs: 5000,
    onOutput: (workerId, line) => {
      try {
        workerLines.push({ workerId, line: JSON.parse(line) });
      } catch {
        workerLines.push({ workerId, line: { unparsed: line } });
      }
    },
  });

  beforeAll(async () => {
    await queue.ensureConsumerGroup();
  });

  afterAll(async () => {
    await pool.stopAll("test-teardown");
    // Workers also write sibling keys (idempotency claims, review and DLQ
    // streams) under the stream's name since STORY-009/007.
    const siblings = await redis.keys(`${streamKey}:*`);
    await redis.del(streamKey, ...siblings);
  });

  it("getBacklog reports undelivered entries and refuses to guess for a missing group", async () => {
    expect(await queue.getBacklog()).toBe(0);
    const missing = new RedisStreamQueue(redis, streamKey, "no-such-group");
    await expect(missing.getBacklog()).rejects.toBeInstanceOf(BacklogUnknownError);
  });

  it("scales real worker processes up for a burst, drains it, then scales back down, all traced by correlation ID", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const scaler = new Autoscaler(() => queue.getBacklog(), pool, {
      minWorkers: 1,
      maxWorkers: 4,
      jobsPerWorker: 10,
      scaleDownAfter: 2,
    });

    // Baseline: one idle worker at min.
    const first = await scaler.evaluate();
    expect(first.action).toBe("scaled_up");
    expect(pool.size()).toBe(1);

    // Load increases: 40 jobs land at once.
    for (let i = 0; i < 40; i++) {
      await queue.enqueue({ id: `burst-${i}`, correlationId: `job-corr-${i}`, idempotencyKey: `burst-${i}`, payload: { i } });
    }
    const up = await scaler.evaluate();
    expect(up.action).toBe("scaled_up");
    expect(up.backlog).toBeGreaterThan(10);
    expect(up.workersAfter).toBeGreaterThan(1);
    expect(up.workersAfter).toBeLessThanOrEqual(4);

    // They are real, separate OS processes.
    const pids = (pool as unknown as { workers: Map<string, { child: { pid: number } }> }).workers;
    const livePids = [...pids.values()].map((w) => w.child.pid);
    expect(new Set(livePids).size).toBe(up.workersAfter);
    for (const pid of livePids) expect(isAlive(pid)).toBe(true);

    // Every scaled-up worker is a live consumer on the group (it has called
    // XREADGROUP). Checked via Redis itself rather than by which worker
    // happened to process jobs: these jobs take ~1ms, so under load the warm
    // worker can drain all 40 before the new ones finish booting. That was a
    // real flake (1 in ~5 full-suite runs), not a scaling bug.
    const consumerNames = async () =>
      ((await redis.xinfo("CONSUMERS", streamKey, groupName)) as unknown[][]).map((c) => String(c[c.indexOf("name") + 1]));
    await waitFor(async () => {
      const names = await consumerNames();
      return pool.workerIds().every((id) => names.includes(id));
    }, 20_000);

    // Workers drain the backlog.
    await waitFor(async () => (await queue.getBacklog()) === 0, 20_000);
    await waitFor(() => workerLines.filter((w) => w.line.event === "job_processed").length === 40, 10_000);

    // Load decreases: deferred once, then scaled down to min.
    expect((await scaler.evaluate()).action).toBe("scale_down_deferred");
    const down = await scaler.evaluate();
    expect(down).toMatchObject({ action: "scaled_down", workersAfter: 1 });
    for (const pid of livePids.slice(1)) expect(isAlive(pid)).toBe(false);

    // Every job processed exactly once across all workers.
    const processedIds = workerLines.filter((w) => w.line.event === "job_processed").map((w) => (w.line.context as { jobId: string }).jobId);
    expect(new Set(processedIds).size).toBe(40);
    expect(processedIds).toHaveLength(40);

    // Trust: scale events carry the correlation ID, and each spawned worker
    // logged worker_started with the ID of the decision that created it.
    const scaleLogs = logs.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => String(l.event).startsWith("autoscale_"));
    expect(scaleLogs.find((l) => l.event === "autoscale_up" && l.correlationId === up.correlationId)).toBeTruthy();
    expect(scaleLogs.find((l) => l.event === "autoscale_down" && l.correlationId === down.correlationId)).toBeTruthy();
    const startedByBurst = workerLines.filter((w) => w.line.event === "worker_started" && w.line.correlationId === up.correlationId);
    expect(startedByBurst).toHaveLength(up.workersAfter - 1);
    // Stopped workers shut down gracefully (exit via signal path), not killed.
    const stopped = workerLines.filter((w) => w.line.event === "worker_stopped");
    expect(stopped.length).toBe(up.workersAfter - 1);
    for (const s of stopped) expect(s.line).toMatchObject({ outcome: "success", context: { stoppedBecause: "signal" } });
  }, 60_000);

  it("force-kills a worker that ignores SIGTERM, so scale-down cannot hang", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stubborn = new ProcessWorkerPool({ entryPath: stubbornEntry, streamKey, groupName, stopGraceMs: 300, execArgv: [] });
    expect(await stubborn.scaleTo(1, "corr-stubborn")).toBe(1);
    // Give the fixture time to install its SIGTERM handler; "spawn" fires
    // before the script itself has run.
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    expect(await stubborn.scaleTo(0, "corr-stubborn-down")).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    const line = JSON.parse(warn.mock.calls.find((c) => String(c[0]).includes("worker_force_killed"))![0] as string);
    expect(line).toMatchObject({ event: "worker_force_killed", correlationId: "corr-stubborn-down" });
    warn.mockRestore();
  });

  it("reports a spawn failure honestly instead of claiming a worker it doesn't have", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new ProcessWorkerPool({ entryPath: workerEntry, streamKey, groupName, execPath: "/nonexistent/node" });
    expect(await broken.scaleTo(2, "corr-broken")).toBe(0);
    const line = JSON.parse(errors.mock.calls.find((c) => String(c[0]).includes("worker_spawn_failed"))![0] as string);
    expect(line).toMatchObject({ event: "worker_spawn_failed", correlationId: "corr-broken", outcome: "failure" });
    errors.mockRestore();
  });

  it("logs a worker that dies on its own, and the autoscaler replaces it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const scaler = new Autoscaler(() => queue.getBacklog(), pool, { minWorkers: 1, maxWorkers: 4, jobsPerWorker: 10, scaleDownAfter: 2 });
    await scaler.evaluate();
    expect(pool.size()).toBe(1);
    const victim = (pool as unknown as { workers: Map<string, { child: { pid: number } }> }).workers.values().next().value!;
    process.kill(victim.child.pid, "SIGKILL");
    await waitFor(() => pool.size() === 0, 5000);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("worker_exited_unexpectedly"))).toBe(true);
    expect((await scaler.evaluate()).action).toBe("scaled_up");
    expect(pool.size()).toBe(1);
    errors.mockRestore();
  }, 20_000);
});
