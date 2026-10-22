// STORY-009 (REQ-008): the chaos-engineering drill, as code. It runs real
// worker processes against real Redis, forces a backlog (including producer
// retries that enqueue the same job twice), SIGKILLs workers while they are
// holding a job, replaces them, and then checks the hypothesis from
// docs/runbooks/CHAOS_DRILL.md: every job is processed exactly once, none
// lost, none duplicated, nothing left pending.
//
// Safety: refuses to run against anything but a local Redis unless
// allowNonLocal is set, uses its own drill-scoped keys, and always stops its
// workers and deletes its keys in `finally`, pass or fail.
//
// Every drill event (started, backlog forced, fault injected, worker
// replaced, completed/failed) is logged with the drill's own correlation ID;
// each job keeps its own correlation ID through the workers' logs.

import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { logJson } from "./logger.js";
import { RedisStreamQueue } from "./queue.js";
import { ProcessWorkerPool } from "./processWorkerPool.js";

export interface ChaosDrillConfig {
  jobs: number;
  // Of those jobs, how many the "producer" enqueues twice (same id and
  // idempotency key), simulating a producer retry.
  duplicateEnqueues: number;
  workers: number;
  kills: number;
  simulatedWorkMs: number;
  reclaimIdleMs: number;
  timeoutMs: number;
  allowNonLocal?: boolean;
  // Every structured line a worker writes, for callers that want the
  // per-job trail (tests, --verbose runs).
  onWorkerLine?: (workerId: string, line: Record<string, unknown>) => void;
}

export interface KilledWorker {
  workerId: string;
  pid: number;
  inFlightJobId: string | null;
  inFlightMessageId: string | null;
  // True when a different worker handled the exact stream message the killed
  // worker was holding (matched by message id): proof the kill landed
  // mid-job and that job was recovered, not just finished from some other
  // copy of it.
  recoveredElsewhere: boolean;
}

export interface ChaosDrillReport {
  drillId: string;
  passed: boolean;
  failures: string[];
  enqueued: number;
  uniqueJobs: number;
  processedOnce: number;
  duplicates: string[];
  lost: string[];
  skippedAsDuplicate: number;
  reclaimed: number;
  killed: KilledWorker[];
  dlqDepth: number;
  pendingAfter: number;
  durationMs: number;
}

export class ChaosDrillRefusedError extends Error {}

export type WorkerLine = { workerId: string; line: Record<string, unknown> };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export async function runChaosDrill(redis: Redis, entryPath: string, config: ChaosDrillConfig): Promise<ChaosDrillReport> {
  const drillId = `chaos-${randomUUID()}`;
  const host = redis.options.host ?? "localhost";
  if (!LOCAL_HOSTS.has(host) && !config.allowNonLocal) {
    logJson("error", { event: "chaos_drill_refused", correlationId: drillId, outcome: "failure", context: { host } });
    throw new ChaosDrillRefusedError(`Refusing to run a chaos drill against non-local Redis host ${host}`);
  }

  const started = Date.now();
  const keys = { stream: `relay:chaos:${drillId}`, idem: `relay:chaos:${drillId}:idem:`, review: `relay:chaos:${drillId}:review`, dlq: `relay:chaos:${drillId}:dlq` };
  const group = "relay-chaos";
  const queue = new RedisStreamQueue(redis, keys.stream, group);
  const lines: WorkerLine[] = [];
  const inFlight = new Map<string, { jobId: string; messageId: string } | null>();
  const pool = new ProcessWorkerPool({
    entryPath,
    streamKey: keys.stream,
    groupName: group,
    stopGraceMs: 5000,
    env: {
      RELAY_SIMULATED_WORK_MS: String(config.simulatedWorkMs),
      RELAY_RECLAIM_IDLE_MS: String(config.reclaimIdleMs),
      RELAY_IDEMPOTENCY_PREFIX: keys.idem,
      RELAY_REVIEW_STREAM_KEY: keys.review,
      RELAY_DLQ_STREAM_KEY: keys.dlq,
    },
    onOutput: (workerId, raw) => {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw);
      } catch {
        line = { event: "unparsed", raw };
      }
      lines.push({ workerId, line });
      config.onWorkerLine?.(workerId, line);
      const context = (line.context ?? {}) as { jobId?: string; messageId?: string };
      if (line.event === "job_dequeued" && context.jobId && context.messageId) inFlight.set(workerId, { jobId: context.jobId, messageId: context.messageId });
      if (line.event === "job_processed" || line.event === "job_skipped_duplicate") inFlight.set(workerId, null);
    },
  });

  logJson("info", { event: "chaos_drill_started", correlationId: drillId, context: { ...config, onWorkerLine: undefined, host } });
  const killed: Omit<KilledWorker, "recoveredElsewhere">[] = [];
  try {
    await queue.ensureConsumerGroup();
    const jobIds: string[] = [];
    for (let i = 0; i < config.jobs; i++) {
      const id = `${drillId}-job-${i}`;
      jobIds.push(id);
      const job = { id, correlationId: `${drillId}-job-${i}`, idempotencyKey: id, payload: { i } };
      await queue.enqueue(job);
      if (i < config.duplicateEnqueues) await queue.enqueue(job);
    }
    logJson("info", {
      event: "chaos_backlog_forced",
      correlationId: drillId,
      context: { jobs: config.jobs, duplicateEnqueues: config.duplicateEnqueues, backlog: await queue.getBacklog() },
    });

    await pool.scaleTo(config.workers, drillId);

    const processedCount = () => new Set(lines.filter((l) => l.line.event === "job_processed").map((l) => (l.line.context as { jobId: string }).jobId)).size;
    for (let k = 0; k < config.kills; k++) {
      // Spread the kills across the run (after ~1/(kills+1) of the jobs, then
      // ~2/(kills+1), ...) rather than all at start-up.
      const threshold = Math.floor((config.jobs * k) / (config.kills + 1));
      await waitFor(() => (processedCount() >= threshold ? true : null), config.timeoutMs);
      const target = await waitFor(() => [...inFlight.entries()].find(([id, job]) => job !== null && pool.workerIds().includes(id)) ?? null, config.timeoutMs);
      if (!target) break;
      const [workerId, held] = target;
      const pid = await pool.killWorker(workerId, "SIGKILL");
      if (pid === null) continue;
      killed.push({ workerId, pid, inFlightJobId: held?.jobId ?? null, inFlightMessageId: held?.messageId ?? null });
      inFlight.delete(workerId);
      logJson("warn", {
        event: "chaos_fault_injected",
        correlationId: drillId,
        context: { fault: "SIGKILL", workerId, pid, inFlightJobId: held?.jobId ?? null, inFlightMessageId: held?.messageId ?? null, processedSoFar: processedCount() },
      });
      const replacedWith = await pool.scaleTo(config.workers, drillId);
      logJson("info", { event: "chaos_worker_replaced", correlationId: drillId, context: { killedWorkerId: workerId, workers: replacedWith } });
    }

    const processedIds = () => lines.filter((l) => l.line.event === "job_processed").map((l) => (l.line.context as { jobId: string }).jobId);
    await waitFor(async () => (new Set(processedIds()).size >= config.jobs && (await pendingCount(redis, keys.stream, group)) === 0 ? true : null), config.timeoutMs);

    const report = buildReport(drillId, config, jobIds, lines, killed, {
      dlqDepth: await redis.xlen(keys.dlq),
      pendingAfter: await pendingCount(redis, keys.stream, group),
      durationMs: Date.now() - started,
    });
    logJson(report.passed ? "info" : "error", {
      event: report.passed ? "chaos_drill_completed" : "chaos_drill_failed",
      correlationId: drillId,
      outcome: report.passed ? "success" : "failure",
      context: { ...report, duplicates: report.duplicates.length, lost: report.lost.length },
    });
    return report;
  } catch (error) {
    logJson("error", {
      event: "chaos_drill_failed",
      correlationId: drillId,
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally {
    await pool.stopAll(`${drillId}-teardown`);
    const idemKeys = await redis.keys(`${keys.idem}*`);
    await redis.del(keys.stream, keys.review, keys.dlq, ...idemKeys);
  }
}

function buildReport(
  drillId: string,
  config: ChaosDrillConfig,
  jobIds: string[],
  lines: WorkerLine[],
  killed: Omit<KilledWorker, "recoveredElsewhere">[],
  extra: { dlqDepth: number; pendingAfter: number; durationMs: number }
): ChaosDrillReport {
  const counts = new Map<string, number>();
  for (const { line } of lines) {
    if (line.event !== "job_processed") continue;
    const jobId = (line.context as { jobId: string }).jobId;
    counts.set(jobId, (counts.get(jobId) ?? 0) + 1);
  }
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  const lost = jobIds.filter((id) => !counts.has(id));
  const killedReport = killed.map((k) => ({
    ...k,
    // Any other worker picking up that exact message (job_dequeued is logged
    // for fresh reads and reclaims alike). Usually that's a reclaim after the
    // kill; with aggressive reclaim settings the killed worker may itself
    // have taken the message over from a slow-but-alive worker, which then
    // finishes it.
    recoveredElsewhere: lines.some(
      (l) => l.line.event === "job_dequeued" && l.workerId !== k.workerId && (l.line.context as { messageId?: string }).messageId === k.inFlightMessageId
    ),
  }));

  const failures: string[] = [];
  if (lost.length) failures.push(`${lost.length} job(s) lost`);
  if (duplicates.length) failures.push(`${duplicates.length} job(s) processed more than once`);
  if (extra.pendingAfter) failures.push(`${extra.pendingAfter} message(s) still pending`);
  if (extra.dlqDepth) failures.push(`${extra.dlqDepth} job(s) dead-lettered`);
  if (killedReport.length < config.kills) failures.push(`only ${killedReport.length} of ${config.kills} planned kills happened`);
  const unrecovered = killedReport.filter((k) => !k.recoveredElsewhere).length;
  if (unrecovered) failures.push(`${unrecovered} killed worker(s) held a job no other worker reclaimed`);

  return {
    drillId,
    passed: failures.length === 0,
    failures,
    enqueued: config.jobs + config.duplicateEnqueues,
    uniqueJobs: config.jobs,
    processedOnce: [...counts.values()].filter((n) => n === 1).length,
    duplicates,
    lost,
    skippedAsDuplicate: lines.filter((l) => l.line.event === "job_skipped_duplicate").length,
    reclaimed: lines.filter((l) => l.line.event === "job_reclaimed").length,
    killed: killedReport,
    ...extra,
  };
}

async function pendingCount(redis: Redis, stream: string, group: string): Promise<number> {
  const summary = (await redis.xpending(stream, group)) as [number, ...unknown[]];
  return Number(summary[0] ?? 0);
}

// Polls until check returns non-null, or gives up (null) after timeoutMs.
async function waitFor<T>(check: () => T | null | Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}
