// STORY-006: scale worker processes on queue depth (REQ-007). Each
// evaluation reads the backlog, computes how many workers it needs, and asks
// the pool for that many. Every evaluation that changes (or tries to change)
// the worker count is logged with its own fresh correlation ID, and that same
// ID is handed to any worker it spawns, so "why does worker X exist" is
// answerable from the logs.
//
// Policy: scale up immediately (a growing backlog is the expensive case),
// scale down only after the backlog has stayed low for scaleDownAfter
// evaluations in a row, so a brief lull between bursts doesn't kill workers
// that are about to be needed again.
//
// Failure paths (the story's three):
// - Workers do not scale up: a backlog read that fails or times out holds the
//   current count (never guesses), logs autoscale_backlog_unavailable, and
//   retries next evaluation. A pool that throws logs autoscale_failed; a pool
//   that comes up short logs autoscale_shortfall. Both retry next evaluation.
// - Workers do not scale down: same backlog/pool handling, and the pool
//   itself force-kills a worker that won't stop (processWorkerPool.ts).
// - Autoscaling fails to log: a throwing logger never stops a scaling
//   decision. The failure is counted in status().logFailures so it stays
//   visible instead of being silently swallowed.

import { randomUUID } from "node:crypto";
import { logJson, type LogFields, type LogLevel } from "./logger.js";
import type { WorkerPool } from "./processWorkerPool.js";

export interface AutoscalerConfig {
  minWorkers: number;
  maxWorkers: number;
  // Backlog one worker is expected to absorb; target = ceil(backlog / this).
  jobsPerWorker: number;
  scaleDownAfter: number;
  backlogTimeoutMs?: number;
}

export function desiredWorkerCount(backlog: number, config: AutoscalerConfig): number {
  const wanted = Math.ceil(backlog / config.jobsPerWorker);
  return Math.min(config.maxWorkers, Math.max(config.minWorkers, wanted));
}

export type AutoscaleAction =
  | "scaled_up"
  | "scaled_down"
  | "hold"
  | "scale_down_deferred"
  | "backlog_unavailable"
  | "failed";

export interface AutoscaleDecision {
  action: AutoscaleAction;
  correlationId: string;
  backlog: number | null;
  workersBefore: number;
  workersAfter: number;
  target: number | null;
}

export interface AutoscalerStatus {
  workers: number;
  lastBacklog: number | null;
  lastAction: AutoscaleAction | null;
  logFailures: number;
}

export interface AutoscalerDeps {
  newCorrelationId?: () => string;
  log?: (level: LogLevel, fields: LogFields) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new BacklogTimeoutError(`backlog read exceeded ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class BacklogTimeoutError extends Error {}

export class Autoscaler {
  private lowStreak = 0;
  private lastBacklog: number | null = null;
  private lastAction: AutoscaleAction | null = null;
  private logFailures = 0;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  // In stop(), awaiting an evaluation that rejected must not throw again.
  private settled(): Promise<unknown> {
    return (this.running ?? Promise.resolve()).catch(() => undefined);
  }
  private stopped = true;
  private readonly newCorrelationId: () => string;
  private readonly log: (level: LogLevel, fields: LogFields) => void;

  constructor(
    private readonly getBacklog: () => Promise<number>,
    private readonly pool: WorkerPool,
    private readonly config: AutoscalerConfig,
    deps: AutoscalerDeps = {}
  ) {
    if (config.minWorkers < 0 || config.maxWorkers < config.minWorkers || config.jobsPerWorker <= 0) {
      throw new RangeError("Autoscaler config needs 0 <= minWorkers <= maxWorkers and jobsPerWorker > 0");
    }
    this.newCorrelationId = deps.newCorrelationId ?? randomUUID;
    this.log = deps.log ?? logJson;
  }

  status(): AutoscalerStatus {
    return {
      workers: this.pool.size(),
      lastBacklog: this.lastBacklog,
      lastAction: this.lastAction,
      logFailures: this.logFailures,
    };
  }

  async evaluate(): Promise<AutoscaleDecision> {
    const correlationId = this.newCorrelationId();
    const workersBefore = this.pool.size();
    const decide = (action: AutoscaleAction, backlog: number | null, target: number | null): AutoscaleDecision => {
      this.lastAction = action;
      return { action, correlationId, backlog, workersBefore, workersAfter: this.pool.size(), target };
    };

    let backlog: number;
    try {
      backlog = await withTimeout(this.getBacklog(), this.config.backlogTimeoutMs ?? 2000);
    } catch (error) {
      this.safeLog("warn", {
        event: "autoscale_backlog_unavailable",
        correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { workers: workersBefore, action: "hold_current_count" },
      });
      return decide("backlog_unavailable", null, null);
    }
    this.lastBacklog = backlog;

    const target = desiredWorkerCount(backlog, this.config);
    if (target === workersBefore) {
      this.lowStreak = 0;
      return decide("hold", backlog, target);
    }

    if (target < workersBefore) {
      this.lowStreak += 1;
      if (this.lowStreak < this.config.scaleDownAfter) {
        this.safeLog("info", {
          event: "autoscale_down_deferred",
          correlationId,
          context: { backlog, workers: workersBefore, target, lowStreak: this.lowStreak, scaleDownAfter: this.config.scaleDownAfter },
        });
        return decide("scale_down_deferred", backlog, target);
      }
    }
    this.lowStreak = 0;

    const direction = target > workersBefore ? "up" : "down";
    let actual: number;
    try {
      actual = await this.pool.scaleTo(target, correlationId);
    } catch (error) {
      this.safeLog("error", {
        event: "autoscale_failed",
        correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { direction, backlog, from: workersBefore, target, workersNow: this.pool.size() },
      });
      return decide("failed", backlog, target);
    }

    if (actual !== target) {
      this.safeLog("warn", {
        event: "autoscale_shortfall",
        correlationId,
        outcome: "failure",
        context: { direction, backlog, from: workersBefore, target, actual },
      });
    }
    this.safeLog("info", {
      event: direction === "up" ? "autoscale_up" : "autoscale_down",
      correlationId,
      outcome: actual === target ? "success" : "failure",
      context: { backlog, from: workersBefore, to: actual, target },
    });
    return decide(direction === "up" ? "scaled_up" : "scaled_down", backlog, target);
  }

  // Self-scheduling rather than setInterval, so a slow evaluation (spawning
  // several processes) can never overlap the next one.
  start(intervalMs: number): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      this.running = this.evaluate();
      try {
        await this.running;
      } catch (error) {
        // evaluate() handles its own known failures; this is the backstop so
        // an unexpected throw is logged and the loop keeps running.
        this.safeLog("error", {
          event: "autoscale_evaluation_crashed",
          correlationId: this.newCorrelationId(),
          outcome: "failure",
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        });
      }
      if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.settled();
  }

  private safeLog(level: LogLevel, fields: LogFields): void {
    try {
      this.log(level, fields);
    } catch {
      // Not swallowed: counted and exposed via status().logFailures. Logging
      // the logging failure would just hit the same broken logger.
      this.logFailures += 1;
    }
  }
}
