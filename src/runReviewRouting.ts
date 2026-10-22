// STORY-007 demo: a batch of classification jobs with mixed confidence goes
// through the real worker loop and real Redis. Prints where each job ended
// up, so it's visible that low-confidence jobs land in the review queue and
// are not resolved. Needs `docker compose up -d redis`.

import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { runWorkerLoop } from "./workerLoop.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";
import { LOW_CONFIDENCE_THRESHOLD } from "./confidence.js";

const KEYS = { main: "relay:demo:review-main", review: "relay:demo:review", dlq: "relay:demo:review-dlq" };
const BATCH: Array<[string, number]> = [
  ["Acme Robotics", 0.94],
  ["Blue Harbor Foods", 0.31],
  ["Cobalt Analytics", 0.88],
  ["Delta Freight", 0.49],
  ["Evergreen Clinics", 0.5],
  ["Fable & Co", 0.12],
];

async function main() {
  const redis = new Redis({ connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 2 });
  await redis.del(KEYS.main, KEYS.review, KEYS.dlq);
  const queue = new RedisStreamQueue(redis, KEYS.main, "relay-demo");
  const review = new RedisStreamQueue(redis, KEYS.review, "relay-review");
  const dlq = new RedisStreamQueue(redis, KEYS.dlq, "relay-dlq");
  await queue.ensureConsumerGroup();
  await dlq.ensureConsumerGroup();

  for (const [i, [company, confidence]] of BATCH.entries()) {
    await queue.enqueue({ id: `cls-${i + 1}`, correlationId: `demo-corr-${i + 1}`, idempotencyKey: `cls-${i + 1}`, confidence, payload: { company } });
  }

  const events: Array<Record<string, unknown>> = [];
  const capture = (text: unknown) => events.push(JSON.parse(String(text)));
  console.log = capture;
  console.warn = capture;
  const controller = new AbortController();
  const loop = runWorkerLoop(queue, new InMemoryIdempotencyStore(), {
    workerId: "demo-worker",
    correlationId: "demo-scale",
    signal: controller.signal,
    reviewQueue: review,
    dlq,
    idlePollMs: 20,
  });
  while ((await queue.getBacklog()) > 0) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  await loop;

  const inReview = new Set((await review.peek(100)).map((j) => j.id));
  process.stderr.write(`threshold = ${LOW_CONFIDENCE_THRESHOLD}\n\n`);
  for (const [i, [company, confidence]] of BATCH.entries()) {
    const id = `cls-${i + 1}`;
    const resolved = events.some((e) => e.event === "job_processed" && (e.context as { jobId: string }).jobId === id);
    const where = inReview.has(id) ? "REVIEW QUEUE (not resolved)" : resolved ? "processed" : "UNACCOUNTED";
    process.stderr.write(`${id}  ${company.padEnd(18)} confidence ${confidence.toFixed(2)}  ->  ${where}   corr=demo-corr-${i + 1}\n`);
  }
  process.stderr.write(`\nreview queue: ${inReview.size}   dlq: ${await redis.xlen(KEYS.dlq)}\n`);
  redis.disconnect();
}

main().catch((error) => {
  process.stderr.write(`review routing demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
