// STORY-010: Relay's production entry point. One process runs:
// - the autoscaler (STORY-006) over a pool of real worker processes
//   (STORY-007/008/009 behaviour inside each worker),
// - the job outcome tracker + monitoring sampler (REQ-014),
// - the read-only status server (REQ-013).
//
// Config comes only from the environment (see fly.toml and
// docs/runbooks/DEPLOYMENT.md); REDIS_URL is a secret. SIGTERM (a deploy or
// `fly machine stop`) shuts down in order: stop scaling, stop sampling, let
// workers finish the job they hold, close the server, disconnect.

import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { redisFromEnv, redactRedisUrl } from "./redisConnection.js";
import { RedisStreamQueue } from "./queue.js";
import { ProcessWorkerPool } from "./processWorkerPool.js";
import { Autoscaler } from "./autoscaler.js";
import { MetricsCollector } from "./metrics.js";
import { JobOutcomeTracker } from "./jobOutcomeTracker.js";
import { MonitoringSampler } from "./monitoringSampler.js";
import { createStatusServer } from "./statusServer.js";
import { logJson } from "./logger.js";
import { STREAM_DEFAULTS } from "./streams.js";
import { classifierFromEnv } from "./classifierAdapter.js";
import { createConsoleHandler } from "./console/routes.js";
import { OperatorStore } from "./console/auth/operators.js";
import { SessionStore } from "./console/auth/sessions.js";
import { LoginLimiter } from "./console/auth/loginLimiter.js";
import { AuditLog } from "./console/audit.js";
import { ActionRunner } from "./console/actions.js";
import { batchConsole } from "./console/batchPages.js";
import { BatchStore } from "./console/batches.js";
import { BatchResults } from "./batchResults.js";
import { batchRetentionDaysFromEnv } from "./batchRetention.js";
import { reviewConsole } from "./console/reviewPages.js";
import { ReviewItems } from "./console/reviewItems.js";
import { cachedTaxonomy } from "./classifyJob.js";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`server: env ${name} must be a non-negative number`);
  return value;
}

const STREAMS = STREAM_DEFAULTS;

async function main(): Promise<void> {
  const bootId = randomUUID();
  const port = num("PORT", 8080);
  const sampleIntervalMs = num("RELAY_SAMPLE_INTERVAL_MS", 60_000);
  const targetSuccessRate = num("RELAY_TARGET_SUCCESS_RATE", 0.9);
  const dlqStream = STREAMS.dlq;
  const reviewStream = STREAMS.review;

  // STORY-103: refuse to start with a misconfigured classifier, rather than
  // letting every worker crash on its first batch item.
  classifierFromEnv();
  const retentionDays = batchRetentionDaysFromEnv();
  const redis = redisFromEnv();
  const queue = new RedisStreamQueue(redis, STREAMS.jobs, STREAMS.group);
  await queue.ensureConsumerGroup();

  const metrics = new MetricsCollector({ windowSize: num("RELAY_SLO_WINDOW", 200), targetSuccessRate });
  const tracker = new JobOutcomeTracker(metrics);
  // Running compiled (dist/*.js) in production, tsx (*.ts) in development.
  const compiled = import.meta.url.endsWith(".js");
  const pool = new ProcessWorkerPool({
    entryPath: fileURLToPath(new URL(compiled ? "./workerProcess.js" : "./workerProcess.ts", import.meta.url)),
    execArgv: compiled ? [] : ["--import", "tsx"],
    streamKey: STREAMS.jobs,
    groupName: STREAMS.group,
    stopGraceMs: num("RELAY_WORKER_STOP_GRACE_MS", 20_000),
    onOutput: (_workerId, raw) => {
      process.stdout.write(`${raw}\n`);
      try {
        tracker.observe(JSON.parse(raw));
      } catch {
        // A non-JSON line (e.g. a Node warning) is passed through above and
        // simply isn't a job event; nothing to track.
      }
    },
  });
  const autoscaler = new Autoscaler(() => queue.getBacklog(), pool, {
    minWorkers: num("RELAY_MIN_WORKERS", 1),
    maxWorkers: num("RELAY_MAX_WORKERS", 3),
    jobsPerWorker: num("RELAY_JOBS_PER_WORKER", 25),
    scaleDownAfter: num("RELAY_SCALE_DOWN_AFTER", 3),
  });
  const sampler = new MonitoringSampler({
    redis,
    queue,
    queueStream: STREAMS.jobs,
    queueGroup: STREAMS.group,
    dlqStream,
    reviewStream,
    metrics,
    tracker,
    workerCount: () => pool.size(),
  });
  // STORY-101: analyst console (login with password + authenticator code).
  const trustProxy = process.env.RELAY_TRUST_PROXY === "true";
  const audit = new AuditLog(redis);
  const batchResults = new BatchResults(redis, undefined, retentionDays);
  const consoleHandler = createConsoleHandler({
    audit,
    actions: new ActionRunner(redis, audit, trustProxy),
    // STORY-104/105: batch upload, submit, progress and results download.
    // STORY-106: review decisions.
    extensions: [
      batchConsole({ store: new BatchStore(redis, undefined, retentionDays), results: batchResults, queue, audit }),
      reviewConsole({ items: new ReviewItems(redis, reviewStream), results: batchResults, audit, getTaxonomy: cachedTaxonomy() }),
    ],
    operators: new OperatorStore(redis),
    sessions: new SessionStore(redis),
    limiter: new LoginLimiter(redis),
    cookieSecure: process.env.RELAY_COOKIE_SECURE === "true",
    trustProxy,
  });
  const server = createStatusServer({ redis, sampler, metrics, sampleIntervalMs, targetSuccessRate, dlqStream, console: consoleHandler });

  autoscaler.start(num("RELAY_SCALE_INTERVAL_MS", 5000));
  await sampler.sampleOnce();
  sampler.start(sampleIntervalMs);
  server.listen(port, () => {
    logJson("info", {
      event: "relay_started",
      correlationId: bootId,
      context: { port, redis: redactRedisUrl(process.env.REDIS_URL), stream: STREAMS.jobs, sampleIntervalMs },
    });
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logJson("info", { event: "relay_stopping", correlationId: bootId, context: { signal } });
    sampler.stop();
    await autoscaler.stop();
    await pool.stopAll(bootId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    redis.disconnect();
    logJson("info", { event: "relay_stopped", correlationId: bootId, outcome: "success" });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logJson("error", {
    event: "relay_start_failed",
    correlationId: "boot",
    outcome: "failure",
    errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
    context: { message: error instanceof Error ? error.message : String(error) },
  });
  process.exit(1);
});
