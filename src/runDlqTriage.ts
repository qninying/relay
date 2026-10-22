// STORY-008 demo: automated DLQ triage updating the retry policy, and a
// failing call following the updated policy. Real Redis, real code paths;
// only the external API is a stand-in that always fails with the chosen
// error. Needs `docker compose up -d redis`.

import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { RedisRetryPolicyStore } from "./retryPolicyStore.js";
import { triageNextDlqEntry } from "./dlqTriage.js";
import { callExternalApiAndPersist } from "./callExternalApi.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import type { RetryPolicy } from "./retryPolicy.js";

const K = { dlq: "relay:demo:triage-dlq", work: "relay:demo:triage-work", esc: "relay:demo:triage-esc", policy: "relay:demo:retry-policy" };
const out = (line: string) => process.stderr.write(`${line}\n`);

function failing(status: number, message: string) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    throw Object.assign(new Error(message), { status });
  };
  return { fn, calls: () => calls };
}

function describeRules(policy: RetryPolicy): string {
  return (["client_error", "timeout", "upstream_error"] as const)
    .map((c) => `${c}=${policy.rules[c].action}/${policy.rules[c].maxAttempts}x/${policy.rules[c].baseDelayMs}ms`)
    .join("  ");
}

async function main() {
  const redis = new Redis({ connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 2 });
  await redis.del(...Object.values(K));
  for (const key of await redis.keys("relay:dlq-resubmits:demo-*")) await redis.del(key);
  const dlq = new RedisStreamQueue(redis, K.dlq, "g");
  const workQueue = new RedisStreamQueue(redis, K.work, "g");
  const escalationQueue = new RedisStreamQueue(redis, K.esc, "g");
  for (const q of [dlq, workQueue, escalationQueue]) await q.ensureConsumerGroup();
  const policyStore = new RedisRetryPolicyStore(redis, K.policy);
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  const schema = { jobType: "lead_enrichment", requiredFields: ["industry"], allowedFields: new Set(["industry"]) };
  const reliability = { timeoutMs: 500, maxRetries: 4, baseDelayMs: 1, maxDelayMs: 2000 };
  const breaker = () => new CircuitBreaker({ failureThreshold: 100, windowMs: 60_000, cooldownMs: 1000 });
  const call = async (id: string, status: number, message: string) => {
    const api = failing(status, message);
    const policy = await policyStore.get(`demo-${id}`);
    const job = { id, correlationId: `demo-${id}`, idempotencyKey: `demo-${id}`, payload: { company: id } };
    const result = await callExternalApiAndPersist(api.fn, schema, job.correlationId, breaker(), { ...reliability, retryPolicy: policy }, { job, dlq });
    out(`  call ${id.padEnd(10)} ${message.padEnd(26)} attempts=${api.calls()}  -> ${result.status}   (policy v${policy.version})`);
  };

  out(`policy v${(await policyStore.get("demo")).version}: ${describeRules(await policyStore.get("demo"))}\n`);
  out("1) jobs fail and exhaust retries under the initial policy:");
  await call("acme", 400, "400 Bad Request");
  await call("blueharbor", 503, "503 Service Unavailable");
  await call("odd", 418, "vendor returned a haiku");

  out("\n2) automated triage of the DLQ:");
  for (;;) {
    const r = await triageNextDlqEntry({ dlq, workQueue, escalationQueue, policyStore, redis, consumerName: "demo-triager" });
    if (r.outcome === "empty") break;
    if (r.outcome === "policy_update_failed") {
      out(`  ${r.jobId.padEnd(10)} policy update failed, entry returned to DLQ`);
      continue;
    }
    out(`  ${r.jobId.padEnd(10)} class=${r.failureClass.padEnd(15)} -> ${r.outcome.padEnd(11)} policy ${r.policyChanged ? `updated to v${r.policyVersion}` : "unchanged"}   corr=${r.correlationId}`);
  }
  const updated = await policyStore.get("demo");
  out(`\npolicy v${updated.version}: ${describeRules(updated)}`);

  out("\n3) the same failures again, now following the updated policy:");
  await call("acme-2", 400, "400 Bad Request");
  await call("cobalt", 503, "503 Service Unavailable");

  out(`\nneeds a human: ${(await escalationQueue.peek(10)).map((e) => e.id).join(", ") || "none"}   resubmitted: ${(await workQueue.peek(10)).map((e) => e.id).join(", ") || "none"}`);
  redis.disconnect();
}

main().catch((error) => {
  process.stderr.write(`dlq triage demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
