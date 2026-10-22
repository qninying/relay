// Unit tests for the scaling policy and its failure paths, with an in-memory
// pool so each decision is deterministic. autoscaler.integration.test.ts
// proves the same thing against real Redis and real worker processes.

import { describe, it, expect } from "vitest";
import { Autoscaler, desiredWorkerCount, type AutoscalerConfig } from "./autoscaler.js";
import type { LogFields, LogLevel } from "./logger.js";
import type { WorkerPool } from "./processWorkerPool.js";

const config: AutoscalerConfig = { minWorkers: 1, maxWorkers: 5, jobsPerWorker: 10, scaleDownAfter: 3 };

class FakePool implements WorkerPool {
  count = 0;
  calls: Array<{ target: number; correlationId: string }> = [];
  failNext = false;
  capAt: number | null = null;
  size() {
    return this.count;
  }
  async scaleTo(target: number, correlationId: string) {
    this.calls.push({ target, correlationId });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fork failed");
    }
    this.count = this.capAt === null ? target : Math.min(target, this.capAt);
    return this.count;
  }
}

function setup(backlogs: Array<number | Error | "hang">, overrides: Partial<AutoscalerConfig> = {}) {
  const pool = new FakePool();
  const logs: Array<{ level: LogLevel } & LogFields> = [];
  let n = 0;
  let id = 0;
  const scaler = new Autoscaler(
    async () => {
      const next = backlogs[Math.min(n++, backlogs.length - 1)];
      if (next === "hang") return new Promise<number>(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
    pool,
    { ...config, backlogTimeoutMs: 50, ...overrides },
    { newCorrelationId: () => `corr-${++id}`, log: (level, fields) => logs.push({ level, ...fields }) }
  );
  return { pool, logs, scaler };
}

describe("desiredWorkerCount", () => {
  it("is one worker per jobsPerWorker of backlog, clamped to min and max", () => {
    expect(desiredWorkerCount(0, config)).toBe(1);
    expect(desiredWorkerCount(10, config)).toBe(1);
    expect(desiredWorkerCount(11, config)).toBe(2);
    expect(desiredWorkerCount(10_000, config)).toBe(5);
  });

  it("rejects an impossible config instead of scaling nonsensically", () => {
    expect(() => new Autoscaler(async () => 0, new FakePool(), { ...config, maxWorkers: 0 })).toThrow(RangeError);
    expect(() => new Autoscaler(async () => 0, new FakePool(), { ...config, jobsPerWorker: 0 })).toThrow(RangeError);
  });
});

describe("Autoscaler: criterion 1, scale up when load increases", () => {
  it("scales up immediately to match a growing backlog", async () => {
    const { pool, scaler } = setup([5, 35]);
    expect((await scaler.evaluate()).action).toBe("scaled_up"); // 0 -> min 1
    const decision = await scaler.evaluate();
    expect(decision).toMatchObject({ action: "scaled_up", backlog: 35, workersBefore: 1, workersAfter: 4, target: 4 });
    expect(pool.count).toBe(4);
  });

  it("never scales past maxWorkers", async () => {
    const { pool, scaler } = setup([999]);
    await scaler.evaluate();
    expect(pool.count).toBe(5);
  });
});

describe("Autoscaler: criterion 2, scale down when load decreases", () => {
  it("defers scale-down until the backlog stays low for scaleDownAfter evaluations, then scales down", async () => {
    const { pool, scaler } = setup([50, 0, 0, 0]);
    await scaler.evaluate();
    expect(pool.count).toBe(5);
    expect((await scaler.evaluate()).action).toBe("scale_down_deferred");
    expect((await scaler.evaluate()).action).toBe("scale_down_deferred");
    const decision = await scaler.evaluate();
    expect(decision).toMatchObject({ action: "scaled_down", workersBefore: 5, workersAfter: 1 });
  });

  it("resets the low streak when load returns, so a brief lull doesn't kill workers", async () => {
    const { pool, scaler } = setup([50, 0, 0, 50, 0, 0]);
    for (let i = 0; i < 6; i++) await scaler.evaluate();
    expect(pool.count).toBe(5);
  });
});

describe("Autoscaler: trust, events logged with correlation IDs", () => {
  it("logs every scale event with that evaluation's correlation ID, and hands the same ID to the pool", async () => {
    const { pool, logs, scaler } = setup([40, 0, 0, 0]);
    for (let i = 0; i < 4; i++) await scaler.evaluate();
    const up = logs.find((l) => l.event === "autoscale_up");
    const down = logs.find((l) => l.event === "autoscale_down");
    expect(up).toMatchObject({ correlationId: "corr-1", context: { backlog: 40, from: 0, to: 4 } });
    expect(down).toMatchObject({ correlationId: "corr-4", context: { from: 4, to: 1 } });
    expect(pool.calls.map((c) => c.correlationId)).toEqual(["corr-1", "corr-4"]);
    for (const line of logs) expect(line.correlationId).toMatch(/^corr-\d+$/);
  });

  it("does not log when nothing changes (hold), so the log is a record of decisions, not noise", async () => {
    const { logs, scaler } = setup([5, 5, 5]);
    for (let i = 0; i < 3; i++) await scaler.evaluate();
    expect(logs.filter((l) => l.event === "autoscale_up")).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
});

describe("Autoscaler: failure paths", () => {
  it("workers do not scale up: an unreadable backlog holds the current count and logs, never guesses", async () => {
    const { pool, logs, scaler } = setup([30, new Error("redis down")]);
    await scaler.evaluate();
    const decision = await scaler.evaluate();
    expect(decision).toMatchObject({ action: "backlog_unavailable", backlog: null, workersAfter: 3 });
    expect(pool.count).toBe(3);
    expect(logs.at(-1)).toMatchObject({ level: "warn", event: "autoscale_backlog_unavailable", correlationId: "corr-2" });
  });

  it("a backlog read that hangs is cut off by the timeout instead of stalling scaling forever", async () => {
    const { logs, scaler } = setup(["hang"]);
    const decision = await scaler.evaluate();
    expect(decision.action).toBe("backlog_unavailable");
    expect(logs[0]).toMatchObject({ errorClass: "BacklogTimeoutError" });
  });

  it("workers do not scale up: a failing pool is logged, and the next evaluation retries and succeeds", async () => {
    const { pool, logs, scaler } = setup([30, 30]);
    pool.failNext = true;
    expect((await scaler.evaluate()).action).toBe("failed");
    expect(logs[0]).toMatchObject({ level: "error", event: "autoscale_failed", correlationId: "corr-1", errorClass: "Error" });
    expect((await scaler.evaluate()).action).toBe("scaled_up");
    expect(pool.count).toBe(3);
  });

  it("workers do not scale up fully: a shortfall is logged with what was actually reached", async () => {
    const { pool, logs, scaler } = setup([50]);
    pool.capAt = 2;
    await scaler.evaluate();
    expect(logs.find((l) => l.event === "autoscale_shortfall")).toMatchObject({ context: { target: 5, actual: 2 } });
    expect(logs.find((l) => l.event === "autoscale_up")).toMatchObject({ outcome: "failure", context: { to: 2 } });
  });

  it("workers do not scale down: a failing pool on scale-down is logged and retried", async () => {
    const { pool, logs, scaler } = setup([50, 0], { scaleDownAfter: 1 });
    await scaler.evaluate();
    pool.failNext = true;
    expect((await scaler.evaluate()).action).toBe("failed");
    expect(logs.at(-1)).toMatchObject({ event: "autoscale_failed", context: { direction: "down" } });
    expect((await scaler.evaluate()).action).toBe("scaled_down");
    expect(pool.count).toBe(1);
  });

  it("autoscaling fails to log: scaling still happens and the failure is counted, not swallowed", async () => {
    const pool = new FakePool();
    const scaler = new Autoscaler(async () => 30, pool, config, {
      log: () => {
        throw new Error("stdout closed");
      },
    });
    const decision = await scaler.evaluate();
    expect(decision.action).toBe("scaled_up");
    expect(pool.count).toBe(3);
    expect(scaler.status()).toMatchObject({ workers: 3, lastBacklog: 30, lastAction: "scaled_up", logFailures: 1 });
  });
});

describe("Autoscaler: start/stop loop", () => {
  it("keeps evaluating on an interval until stopped", async () => {
    const { pool, scaler } = setup([30]);
    scaler.start(10);
    await new Promise((r) => setTimeout(r, 50));
    await scaler.stop();
    expect(pool.count).toBe(3);
    const callsAtStop = pool.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(pool.calls.length).toBe(callsAtStop);
  });
});
