// STORY-006 demo: watch real worker processes scale with real queue load.
// Not a test. Drops a burst of jobs on a Redis stream, lets the autoscaler
// fork workers to meet it, waits for the backlog to drain, and prints one
// timeline row per evaluation (backlog, workers, action, correlation ID) so
// the scale-up and scale-down are visible. Needs `docker compose up -d redis`.
//
// Full structured logs go to stdout's raw JSON as usual; pass --quiet to see
// only the timeline.

import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";
import { RedisStreamQueue } from "./queue.js";
import { ProcessWorkerPool } from "./processWorkerPool.js";
import { Autoscaler } from "./autoscaler.js";
import { logJson } from "./logger.js";

const quiet = process.argv.includes("--quiet");
const STREAM_KEY = "relay:demo:autoscale";
const GROUP = "relay-demo-autoscale";
const BURST = Number(process.env.DEMO_BURST ?? 120);

async function main() {
  const redis = new Redis({ connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 2 });
  await redis.del(STREAM_KEY);
  const queue = new RedisStreamQueue(redis, STREAM_KEY, GROUP);
  await queue.ensureConsumerGroup();

  const pool = new ProcessWorkerPool({
    entryPath: fileURLToPath(new URL("./workerProcess.ts", import.meta.url)),
    streamKey: STREAM_KEY,
    groupName: GROUP,
    onOutput: quiet ? () => {} : undefined,
  });
  const scaler = new Autoscaler(() => queue.getBacklog(), pool, {
    minWorkers: 1,
    maxWorkers: 6,
    jobsPerWorker: 15,
    scaleDownAfter: 3,
  }, quiet ? { log: () => {} } : {});

  const started = Date.now();
  const row = (label: string, d: Awaited<ReturnType<Autoscaler["evaluate"]>>) =>
    console.error(
      `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${label.padEnd(8)} backlog=${String(d.backlog).padStart(4)}  workers ${d.workersBefore} -> ${d.workersAfter}  ${d.action.padEnd(20)} corr=${d.correlationId.slice(0, 8)}`
    );

  row("idle", await scaler.evaluate());
  for (let i = 0; i < BURST; i++) {
    await queue.enqueue({ id: `demo-${i}`, correlationId: `demo-job-${i}`, idempotencyKey: `demo-${i}`, payload: { i } });
  }
  console.error(`        ${BURST} jobs enqueued`);

  for (let tick = 0; tick < 40; tick++) {
    const d = await scaler.evaluate();
    row("tick", d);
    if (d.action === "scaled_down" && d.workersAfter === 1) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  await pool.stopAll("demo-shutdown");
  redis.disconnect();
}

main().catch((error) => {
  logJson("error", {
    event: "autoscale_demo_failed",
    correlationId: "demo",
    outcome: "failure",
    errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
    context: { message: error instanceof Error ? error.message : String(error) },
  });
  process.exit(1);
});
