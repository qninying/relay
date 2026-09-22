// Runs the live operations dashboard against real activity for demoing/manual
// verification — not a test, a way to actually see the thing work. Feeds jobs
// through the real processJob() (STORY-001) so the numbers on screen come
// from the same code path production jobs would use, occasionally moves a
// job to the real DLQ (STORY-004) via Redis so the DLQ backlog KPI and the
// attention section show genuine data, and keeps producing a trickle of
// activity so "live" is visibly true, not a static snapshot dressed up as one.

import { Redis } from "ioredis";
import { createDashboardServer } from "./dashboardServer.js";
import { MetricsCollector } from "./metrics.js";
import { processJob, type Job } from "./processJob.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";
import { RedisStreamQueue } from "./queue.js";
import { moveToDeadLetterQueue } from "./dlq.js";

const PORT = Number(process.env.DASHBOARD_PORT ?? 4173);
const DLQ_STREAM_KEY = "relay:demo:dashboard-dlq";

const metrics = new MetricsCollector({ windowSize: 50, targetSuccessRate: 0.9 });
const store = new InMemoryIdempotencyStore();

const brokenStore = {
  claim: () => {
    throw new Error("simulated upstream failure");
  },
};

let counter = 0;
function makeJob(): Job {
  counter += 1;
  return {
    id: `demo-job-${counter}`,
    correlationId: `demo-corr-${counter}`,
    idempotencyKey: `demo-idem-${counter}`,
    payload: { demo: true },
  };
}

function tick() {
  const shouldFail = Math.random() < 0.15; // ~15% failure rate, occasionally over the 90% target
  const job = makeJob();
  const delayMs = Math.floor(50 + Math.random() * 200);
  setTimeout(() => {
    processJob(job, shouldFail ? brokenStore : store, metrics);
  }, delayMs);
}

async function main() {
  // Real Redis if reachable; the dashboard shows "not connected" (null),
  // never a fake 0, if it isn't — same honesty rule as everywhere else.
  const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
  redis.on("error", () => {}); // suppress ioredis's own console.error; connection failure is handled below
  let dlq: RedisStreamQueue | null = null;
  try {
    await redis.connect();
    await redis.ping();
    dlq = new RedisStreamQueue(redis, DLQ_STREAM_KEY, "relay-demo-dlq-group");
    await dlq.ensureConsumerGroup();
    await redis.del(DLQ_STREAM_KEY); // clean slate each demo run
    await dlq.ensureConsumerGroup();
    console.error("relay dashboard: connected to Redis, DLQ backlog is live");
  } catch {
    console.error("relay dashboard: Redis not reachable — DLQ backlog will show \"not connected\" (run `docker compose up -d redis` for the full demo)");
  }

  function maybeMoveToDlq() {
    if (!dlq || Math.random() >= 0.08) return; // ~8% chance per tick
    const job = makeJob();
    void moveToDeadLetterQueue(dlq, job, "simulated: upstream unavailable after 3 attempts");
  }

  const server = createDashboardServer(metrics, {
    getDlqDepth: dlq ? async () => (redis.status === "ready" ? redis.xlen(DLQ_STREAM_KEY) : Promise.reject(new Error("not connected"))) : undefined,
  });
  server.listen(PORT, () => {
    console.error(`relay dashboard: listening on http://localhost:${PORT}`);
  });

  setInterval(() => {
    tick();
    maybeMoveToDlq();
  }, 400);
}

main().catch((error) => {
  console.error("relay dashboard: fatal startup error", error);
  process.exit(1);
});
