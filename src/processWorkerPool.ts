// STORY-006: a pool of real worker OS processes (REQ-007, "multiple
// autoscaling worker processes"), not in-process promises standing in for
// them. scaleTo() forks or stops child processes running workerProcess.ts.
//
// Failure paths:
// - A worker that fails to spawn is logged (worker_spawn_failed) and the pool
//   reports the count it actually reached. It never claims a worker it
//   doesn't have, so the autoscaler can see a shortfall and log it.
// - A worker that ignores SIGTERM past stopGraceMs is SIGKILLed and logged
//   (worker_force_killed), so scale-down can't hang on one stuck process.
// - A worker that exits on its own is removed and logged
//   (worker_exited_unexpectedly). The pool doesn't respawn it itself; the
//   autoscaler's next evaluation sees the lower count and scales back up,
//   which keeps one place deciding how many workers exist.

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { logJson } from "./logger.js";

export interface WorkerPool {
  size(): number;
  // Returns the number of workers actually running afterward, which can be
  // lower than requested if spawns failed.
  scaleTo(target: number, correlationId: string): Promise<number>;
}

export interface ProcessWorkerPoolOptions {
  entryPath: string;
  streamKey: string;
  groupName: string;
  redisUrl?: string;
  stopGraceMs?: number;
  execArgv?: string[];
  // Node binary to run workers with; defaults to the current one.
  execPath?: string;
  // Each line a worker writes to stdout/stderr. Defaults to passing it
  // through unchanged, so worker logs land in the same stream as the pool's.
  onOutput?: (workerId: string, line: string) => void;
}

interface RunningWorker {
  child: ChildProcess;
  correlationId: string;
  stopping: boolean;
  exited: Promise<void>;
}

export class ProcessWorkerPool implements WorkerPool {
  private readonly workers = new Map<string, RunningWorker>();
  private readonly stopGraceMs: number;

  constructor(private readonly options: ProcessWorkerPoolOptions) {
    this.stopGraceMs = options.stopGraceMs ?? 10_000;
  }

  size(): number {
    return this.workers.size;
  }

  workerIds(): string[] {
    return [...this.workers.keys()];
  }

  async scaleTo(target: number, correlationId: string): Promise<number> {
    while (this.workers.size < target) {
      const spawned = await this.spawnOne(correlationId);
      if (!spawned) break;
    }
    const excess = [...this.workers.keys()].slice(target);
    await Promise.all(excess.map((workerId) => this.stopOne(workerId, correlationId)));
    return this.workers.size;
  }

  async stopAll(correlationId: string): Promise<void> {
    await this.scaleTo(0, correlationId);
  }

  private async spawnOne(correlationId: string): Promise<boolean> {
    const workerId = `worker-${randomUUID().slice(0, 8)}`;
    let child: ChildProcess;
    try {
      child = fork(this.options.entryPath, [], {
        execArgv: this.options.execArgv ?? ["--import", "tsx"],
        execPath: this.options.execPath,
        env: {
          ...process.env,
          RELAY_WORKER_ID: workerId,
          RELAY_CORRELATION_ID: correlationId,
          RELAY_STREAM_KEY: this.options.streamKey,
          RELAY_GROUP: this.options.groupName,
          REDIS_URL: this.options.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      logJson("error", {
        event: "worker_spawn_failed",
        correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { workerId },
      });
      return false;
    }

    const onOutput = this.options.onOutput ?? ((_id: string, line: string) => process.stdout.write(`${line}\n`));
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream }).on("line", (line) => onOutput(workerId, line));
    }

    const worker: RunningWorker = {
      child,
      correlationId,
      stopping: false,
      exited: new Promise((resolve) => child.once("exit", () => resolve())),
    };
    child.once("exit", (code, signal) => {
      this.workers.delete(workerId);
      if (!worker.stopping) {
        logJson("error", {
          event: "worker_exited_unexpectedly",
          correlationId: worker.correlationId,
          outcome: "failure",
          context: { workerId, code, signal },
        });
      }
    });
    this.workers.set(workerId, worker);
    return true;
  }

  private async stopOne(workerId: string, correlationId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.stopping = true;
    worker.child.kill("SIGTERM");

    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      worker.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.stopGraceMs);
      }),
    ]);
    clearTimeout(timer);

    if (timedOut) {
      logJson("warn", {
        event: "worker_force_killed",
        correlationId,
        outcome: "failure",
        context: { workerId, stopGraceMs: this.stopGraceMs },
      });
      worker.child.kill("SIGKILL");
      await worker.exited;
    }
  }
}
