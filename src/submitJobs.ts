// STORY-010: put jobs on Relay's queue from inside the deployment, so the
// public status server never needs a write endpoint.
//   fly ssh console -a relay -C "node dist/src/submitJobs.js 200"
//   (locally: npx tsx submitJobs.ts 200)
// Each job gets its own correlation ID and idempotency key, so re-running
// this command submits new jobs; re-delivering the same job never processes
// it twice. Pass --low-confidence N to include N jobs that should be routed
// to the review queue instead of processed (STORY-007).

import { randomUUID } from "node:crypto";
import { redisFromEnv } from "./redisConnection.js";
import { RedisStreamQueue } from "./queue.js";
import { STREAM_DEFAULTS } from "./streams.js";

async function main(): Promise<number> {
  const count = Number(process.argv[2] ?? 10);
  const lowIndex = process.argv.indexOf("--low-confidence");
  const lowConfidence = lowIndex === -1 ? 0 : Number(process.argv[lowIndex + 1] ?? 0);
  if (!Number.isInteger(count) || count < 1 || count > 10_000 || !Number.isInteger(lowConfidence) || lowConfidence < 0 || lowConfidence > count) {
    process.stderr.write("usage: submitJobs <count 1..10000> [--low-confidence <n <= count>]\n");
    return 2;
  }
  const redis = redisFromEnv();
  try {
    const queue = new RedisStreamQueue(redis, STREAM_DEFAULTS.jobs, STREAM_DEFAULTS.group);
    await queue.ensureConsumerGroup();
    const batch = randomUUID().slice(0, 8);
    for (let i = 0; i < count; i++) {
      const id = `batch-${batch}-${i}`;
      await queue.enqueue({
        id,
        correlationId: randomUUID(),
        idempotencyKey: id,
        payload: { batch, index: i },
        ...(i < lowConfidence ? { confidence: 0.3 } : {}),
      });
    }
    process.stderr.write(`submitted ${count} jobs (batch ${batch}, ${lowConfidence} low-confidence); backlog now ${await queue.getBacklog()}\n`);
    return 0;
  } finally {
    redis.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`submitJobs failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
