// STORY-008 against REAL Redis: DLQ entries are triaged automatically, the
// shared retry policy is updated and persisted, the next failing job follows
// the updated policy, and every step is logged with the entry's correlation
// ID. Skips cleanly if Redis isn't reachable.

import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./queue.js";
import { RedisRetryPolicyStore, RetryPolicyUpdateError } from "./retryPolicyStore.js";
import { triageNextDlqEntry, type DlqTriageDeps } from "./dlqTriage.js";
import { moveToDeadLetterQueue } from "./dlq.js";
import { callExternalApiAndPersist } from "./callExternalApi.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { INITIAL_POLICY } from "./retryPolicy.js";
import type { Job } from "./processJob.js";
import type { JobOutputSchema } from "../guardrails/outputContractGuardrail.js";

const redis = new Redis({ lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await redis.connect();
  await redis.ping();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}
if (!redisAvailable) {
  console.warn("[dlqTriage.test.ts] Redis not reachable at localhost:6379, integration tests skipped.");
}

type Line = Record<string, unknown> & { event: string; correlationId: string; context?: Record<string, unknown> };
function captureLogs(): () => Line[] {
  const spies = [console.log, console.warn, console.error].map((_, i) =>
    vi.spyOn(console, (["log", "warn", "error"] as const)[i]).mockImplementation(() => {})
  );
  return () => spies.flatMap((s) => s.mock.calls.map((c) => JSON.parse(c[0] as string) as Line));
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const schema: JobOutputSchema = { jobType: "lead_enrichment", requiredFields: ["industry"], allowedFields: new Set(["industry"]) };
const reliability = { timeoutMs: 500, maxRetries: 4, baseDelayMs: 1, maxDelayMs: 50 };

let n = 0;
function fresh() {
  n += 1;
  const id = `${Math.random().toString(36).slice(2)}-${n}`;
  const keys = { dlq: `relay:test:triage-dlq:${id}`, work: `relay:test:triage-work:${id}`, esc: `relay:test:triage-esc:${id}`, policy: `relay:test:policy:${id}` };
  const dlq = new RedisStreamQueue(redis, keys.dlq, "g-dlq");
  const workQueue = new RedisStreamQueue(redis, keys.work, "g-work");
  const escalationQueue = new RedisStreamQueue(redis, keys.esc, "g-esc");
  const policyStore = new RedisRetryPolicyStore(redis, keys.policy);
  const deps: DlqTriageDeps = { dlq, workQueue, escalationQueue, policyStore, redis, consumerName: "triager", maxResubmits: 2 };
  return { id, keys, deps };
}

// The resubmit counter is durable (keyed on idempotency key, 7-day TTL), so
// keys must be unique per run or reruns would inherit earlier counts.
const RUN = Math.random().toString(36).slice(2, 8);
function job(id: string, overrides: Partial<Job> = {}): Job {
  return { id, correlationId: `corr-${id}`, idempotencyKey: `idem-${id}-${RUN}`, payload: { company: "Acme" }, ...overrides };
}

const cleanup: string[] = [];
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!redisAvailable) return;
  const counters = await redis.keys(`relay:dlq-resubmits:*-${RUN}`);
  const keys = [...cleanup, ...counters];
  if (keys.length) await redis.del(...keys);
});

describe.skipIf(!redisAvailable)("automated DLQ triage (integration, real Redis)", () => {
  let ctx: ReturnType<typeof fresh>;

  function setup() {
    ctx = fresh();
    cleanup.push(...Object.values(ctx.keys));
    return ctx;
  }

  async function ready() {
    await ctx.deps.dlq.ensureConsumerGroup();
    await ctx.deps.workQueue.ensureConsumerGroup();
    await ctx.deps.escalationQueue.ensureConsumerGroup();
  }

  it("criterion 1: triaging a 4xx DLQ entry updates the persisted policy (client_error -> discard), and the entry is discarded", async () => {
    setup();
    await ready();
    const logs = captureLogs();
    await moveToDeadLetterQueue(ctx.deps.dlq, job("bad-input"), "Upstream call failed after 3 attempt(s): 400 Bad Request");

    const result = await triageNextDlqEntry(ctx.deps);
    expect(result).toMatchObject({ outcome: "discarded", failureClass: "client_error", policyChanged: true, policyVersion: 2 });

    const stored = JSON.parse((await redis.get(ctx.keys.policy))!);
    expect(stored.version).toBe(2);
    expect(stored.rules.client_error).toEqual({ action: "discard", maxAttempts: 1, baseDelayMs: 100 });
    expect(stored.history[0]).toMatchObject({ correlationId: "corr-bad-input", failureClass: "client_error" });

    // Trust: the entry's own correlation ID on classification, the policy
    // update, and the outcome.
    const trail = logs().filter((l) => l.correlationId === "corr-bad-input").map((l) => l.event);
    expect(trail).toEqual(expect.arrayContaining(["dlq_entry_classified", "retry_policy_updated", "dlq_entry_discarded"]));
    expect(logs().find((l) => l.event === "retry_policy_updated")).toMatchObject({
      correlationId: "corr-bad-input",
      context: { failureClass: "client_error", fromVersion: 1, toVersion: 2 },
    });
  });

  it("criterion 1: a timeout entry doubles that class's backoff and the job is resubmitted with its original payload and idempotency key", async () => {
    setup();
    await ready();
    captureLogs();
    await moveToDeadLetterQueue(ctx.deps.dlq, job("slow"), "Upstream call failed after 3 attempt(s): Upstream call timed out after 500ms.");

    const result = await triageNextDlqEntry(ctx.deps);
    expect(result).toMatchObject({ outcome: "resubmitted", failureClass: "timeout", policyChanged: true });
    expect((await ctx.deps.policyStore.get("t")).rules.timeout.baseDelayMs).toBe(200);

    const resubmitted = await ctx.deps.workQueue.dequeueOne("w");
    expect(resubmitted).toMatchObject({ id: "slow", correlationId: "corr-slow", idempotencyKey: `idem-slow-${RUN}`, payload: { company: "Acme" } });
  });

  it("criterion 2, end to end: a 4xx job exhausts retries into the DLQ, triage updates the policy, and the next 4xx job fails on its first attempt", async () => {
    setup();
    await ready();
    const logs = captureLogs();
    const breaker = () => new CircuitBreaker({ failureThreshold: 100, windowMs: 60_000, cooldownMs: 1000 });

    // Before triage: the policy still retries client errors (INITIAL_POLICY).
    const firstCall = vi.fn().mockRejectedValue(httpError(400, "400 Bad Request"));
    const before = await callExternalApiAndPersist(firstCall, schema, "corr-first", breaker(), { ...reliability, retryPolicy: await ctx.deps.policyStore.get("corr-first") }, {
      job: job("first"),
      dlq: ctx.deps.dlq,
    });
    expect(before).toMatchObject({ status: "moved_to_dlq" });
    expect(firstCall).toHaveBeenCalledTimes(3);

    // Automated triage of that DLQ entry.
    expect(await triageNextDlqEntry(ctx.deps)).toMatchObject({ outcome: "discarded", policyChanged: true });

    // After triage: the same kind of failure follows the updated policy.
    const secondCall = vi.fn().mockRejectedValue(httpError(400, "400 Bad Request"));
    await callExternalApiAndPersist(secondCall, schema, "corr-second", breaker(), { ...reliability, retryPolicy: await ctx.deps.policyStore.get("corr-second") });
    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(logs().find((l) => l.event === "external_api_call_failed" && l.correlationId === "corr-second")).toMatchObject({
      context: { attempts: 1, failureClass: "client_error", policyVersion: 2 },
    });
  });

  it("an unclassified failure is escalated to a human, never guessed at, and leaves the policy alone", async () => {
    setup();
    await ready();
    captureLogs();
    await moveToDeadLetterQueue(ctx.deps.dlq, job("odd"), "vendor returned a haiku");
    expect(await triageNextDlqEntry(ctx.deps)).toMatchObject({ outcome: "escalated", failureClass: "unclassified", policyChanged: false, policyVersion: 1 });
    expect(await redis.get(ctx.keys.policy)).toBeNull();
    expect(await ctx.deps.escalationQueue.peek(10)).toMatchObject([{ id: "odd", payload: { failureReason: "vendor returned a haiku" } }]);
  });

  it("a job that keeps landing back in the DLQ is escalated after maxResubmits, not resubmitted forever", async () => {
    setup();
    await ready();
    const logs = captureLogs();
    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      await moveToDeadLetterQueue(ctx.deps.dlq, job("flappy"), "503 Service Unavailable");
      outcomes.push((await triageNextDlqEntry(ctx.deps)).outcome);
    }
    expect(outcomes).toEqual(["resubmitted", "resubmitted", "escalated"]);
    expect(logs().find((l) => l.event === "dlq_entry_escalated")).toMatchObject({ correlationId: "corr-flappy", context: { why: "resubmit_limit_reached" } });
  });

  it("re-triaging the same kind of failure is idempotent: no second policy change", async () => {
    setup();
    await ready();
    captureLogs();
    await moveToDeadLetterQueue(ctx.deps.dlq, job("a"), "400 Bad Request");
    await moveToDeadLetterQueue(ctx.deps.dlq, job("b"), "401 Unauthorized");
    expect(await triageNextDlqEntry(ctx.deps)).toMatchObject({ policyChanged: true, policyVersion: 2 });
    expect(await triageNextDlqEntry(ctx.deps)).toMatchObject({ policyChanged: false, policyVersion: 2 });
    expect(await triageNextDlqEntry(ctx.deps)).toEqual({ outcome: "empty" });
  });

  it("failure path: the policy can't be updated, so the entry is put back on the DLQ and nothing else happens", async () => {
    setup();
    await ready();
    const logs = captureLogs();
    const dead = new Redis({ port: 1, lazyConnect: true, retryStrategy: () => null, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    dead.on("error", () => {});
    const deps = { ...ctx.deps, policyStore: new RedisRetryPolicyStore(dead, ctx.keys.policy) };
    await moveToDeadLetterQueue(ctx.deps.dlq, job("stuck"), "400 Bad Request");

    expect(await triageNextDlqEntry(deps)).toMatchObject({ outcome: "policy_update_failed", failureClass: "client_error" });
    expect(logs().find((l) => l.event === "retry_policy_update_failed")).toMatchObject({ correlationId: "corr-stuck" });
    expect(logs().find((l) => l.event === "dlq_entry_returned")).toMatchObject({ correlationId: "corr-stuck" });
    // Back on the DLQ, untouched; a later run with a healthy store triages it.
    expect(await triageNextDlqEntry(ctx.deps)).toMatchObject({ outcome: "discarded", jobId: "stuck" });
    dead.disconnect();
  });

  it("failure path: two triagers on separate connections updating at once both land (no lost update)", async () => {
    setup();
    const other = new Redis({ lazyConnect: true, retryStrategy: () => null });
    await other.connect();
    captureLogs();
    const a = new RedisRetryPolicyStore(redis, ctx.keys.policy);
    const b = new RedisRetryPolicyStore(other, ctx.keys.policy);
    const double = (p: typeof INITIAL_POLICY) => ({ ...p.rules.timeout, baseDelayMs: p.rules.timeout.baseDelayMs * 2 });
    await Promise.all([a.update("timeout", double, "corr-a"), b.update("timeout", double, "corr-b"), a.update("timeout", double, "corr-a2")]);
    const final = await a.get("check");
    expect(final.version).toBe(4);
    expect(final.rules.timeout.baseDelayMs).toBe(800);
    expect(final.history.map((h) => h.correlationId).sort()).toEqual(["corr-a", "corr-a2", "corr-b"]);
    other.disconnect();
  });

  it("failure path: a corrupt stored policy is never used, on read or as the base for an update", async () => {
    setup();
    const logs = captureLogs();
    await redis.set(ctx.keys.policy, JSON.stringify({ version: 9, rules: { timeout: { action: "retry", maxAttempts: 999 } }, history: [] }));
    const store = new RedisRetryPolicyStore(redis, ctx.keys.policy);
    expect(await store.get("corr-read")).toEqual(INITIAL_POLICY);
    expect(logs().find((l) => l.event === "retry_policy_invalid")).toMatchObject({ correlationId: "corr-read" });
    await expect(store.update("timeout", () => INITIAL_POLICY.rules.timeout, "corr-upd")).rejects.toBeInstanceOf(RetryPolicyUpdateError);
  });

  it("an empty DLQ is a no-op", async () => {
    setup();
    await ready();
    expect(await triageNextDlqEntry(ctx.deps)).toEqual({ outcome: "empty" });
  });
});
