// STORY-008: the retry policy lives in Redis, so every worker process (see
// STORY-006's ProcessWorkerPool) reads the same policy and one triage update
// reaches all of them.
//
// Failure paths:
// - Concurrent updates (two triagers at once): optimistic WATCH/MULTI. A
//   conflicting write aborts the transaction and the update is recomputed on
//   the fresh policy, up to MAX_UPDATE_RETRIES, then RetryPolicyUpdateError.
// - Redis unreachable on update: RetryPolicyUpdateError (logged); the caller
//   (dlqTriage.ts) puts the DLQ entry back rather than losing it.
// - Redis unreachable or stored value corrupt on read: logged, and the last
//   policy this process read successfully is used (INITIAL_POLICY if none),
//   so a failing job still gets a sane, bounded retry instead of crashing.

import type { Redis } from "ioredis";
import { logJson } from "./logger.js";
import type { FailureClass } from "./failureClassifier.js";
import { INITIAL_POLICY, applyRuleUpdate, parsePolicy, type ClassRule, type RetryPolicy } from "./retryPolicy.js";

const MAX_UPDATE_RETRIES = 5;

export class RetryPolicyUpdateError extends Error {}

export type PolicyUpdateResult =
  | { changed: false; policy: RetryPolicy }
  | { changed: true; policy: RetryPolicy; from: ClassRule; to: ClassRule };

export class RedisRetryPolicyStore {
  private lastKnownGood: RetryPolicy = INITIAL_POLICY;

  constructor(
    private readonly redis: Redis,
    private readonly key: string = "relay:retry-policy"
  ) {}

  async get(correlationId: string): Promise<RetryPolicy> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.key);
    } catch (error) {
      logJson("warn", {
        event: "retry_policy_read_failed",
        correlationId,
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { usingVersion: this.lastKnownGood.version },
      });
      return this.lastKnownGood;
    }
    if (raw === null) return this.lastKnownGood;
    const parsed = this.parse(raw);
    if (!parsed) {
      logJson("error", {
        event: "retry_policy_invalid",
        correlationId,
        outcome: "failure",
        context: { key: this.key, usingVersion: this.lastKnownGood.version },
      });
      return this.lastKnownGood;
    }
    this.lastKnownGood = parsed;
    return parsed;
  }

  // derive returns the class's new rule, or null for "no change". Logs
  // retry_policy_updated with the triggering correlation ID and the
  // before/after rule on every real change.
  //
  // WATCH is per connection, so two overlapping update() calls on the same
  // client would share (and clobber) one WATCH. Calls on one store are
  // queued; separate processes have separate connections and are protected
  // by WATCH/MULTI itself.
  update(
    failureClass: FailureClass,
    derive: (policy: RetryPolicy) => ClassRule | null,
    correlationId: string
  ): Promise<PolicyUpdateResult> {
    const run = this.queue.then(() => this.updateNow(failureClass, derive, correlationId));
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private queue: Promise<void> = Promise.resolve();

  private async updateNow(
    failureClass: FailureClass,
    derive: (policy: RetryPolicy) => ClassRule | null,
    correlationId: string
  ): Promise<PolicyUpdateResult> {
    for (let attempt = 1; attempt <= MAX_UPDATE_RETRIES; attempt++) {
      let committed: unknown;
      let next: RetryPolicy;
      let current: RetryPolicy;
      try {
        await this.redis.watch(this.key);
        const raw = await this.redis.get(this.key);
        const parsed = raw === null ? INITIAL_POLICY : this.parse(raw);
        if (!parsed) {
          await this.redis.unwatch();
          throw new RetryPolicyUpdateError(`Stored retry policy at ${this.key} is invalid; refusing to build on it`);
        }
        current = parsed;
        const to = derive(current);
        if (!to) {
          await this.redis.unwatch();
          this.lastKnownGood = current;
          return { changed: false, policy: current };
        }
        next = applyRuleUpdate(current, failureClass, to, correlationId);
        committed = await this.redis.multi().set(this.key, JSON.stringify(next)).exec();
      } catch (error) {
        const wrapped = error instanceof RetryPolicyUpdateError ? error : new RetryPolicyUpdateError(String(error instanceof Error ? error.message : error));
        logJson("error", {
          event: "retry_policy_update_failed",
          correlationId,
          outcome: "failure",
          errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
          context: { failureClass, attempt },
        });
        throw wrapped;
      }
      // exec() resolves null when a WATCHed key changed: someone else updated
      // the policy first. Recompute on the new policy.
      if (committed === null) continue;

      this.lastKnownGood = next;
      const change = next.history[next.history.length - 1];
      logJson("info", {
        event: "retry_policy_updated",
        correlationId,
        outcome: "success",
        context: { failureClass, fromVersion: current.version, toVersion: next.version, from: change.from, to: change.to },
      });
      return { changed: true, policy: next, from: change.from, to: change.to };
    }
    logJson("error", {
      event: "retry_policy_update_failed",
      correlationId,
      outcome: "failure",
      errorClass: "RetryPolicyUpdateError",
      context: { failureClass, reason: "concurrent_update_conflicts", attempts: MAX_UPDATE_RETRIES },
    });
    throw new RetryPolicyUpdateError(`Retry policy update for ${failureClass} lost ${MAX_UPDATE_RETRIES} concurrent-update races`);
  }

  private parse(raw: string): RetryPolicy | null {
    try {
      return parsePolicy(JSON.parse(raw));
    } catch {
      // Malformed JSON is the same outcome as a wrong shape: invalid. The
      // caller logs it with the correlation ID it has.
      return null;
    }
  }
}
