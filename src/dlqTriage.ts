// STORY-008 (REQ-015): automated DLQ triage. Takes one DLQ entry, classifies
// its failure (failureClassifier.ts), updates the shared retry policy by the
// codified rules (retryPolicy.ts), then acts on the entry under the updated
// policy:
// - retry: resubmit the original job to the work queue with the same
//   idempotency key (safe to repeat, REQ-002). A job resubmitted more than
//   maxResubmits times is escalated instead (runbook: "if the same job keeps
//   landing back in the DLQ, stop").
// - discard: logged as dropped, with its class, so nothing vanishes silently.
// - escalate: copied to the escalation stream for a human. This is the only
//   path that still needs manual review.
//
// Every step logs with the entry's own correlation ID, so one job's whole
// trail (failed, dead-lettered, triaged, policy updated, resubmitted) is
// one search.
//
// Failure path: if the policy update fails, the entry is put back on the DLQ
// unchanged and nothing else happens, so a triage can be safely re-run.

import type { Redis } from "ioredis";
import { logJson } from "./logger.js";
import type { RedisStreamQueue } from "./queue.js";
import type { Job } from "./processJob.js";
import { classifyReason, type FailureClass } from "./failureClassifier.js";
import { deriveRuleUpdate, type RuleAction } from "./retryPolicy.js";
import type { RedisRetryPolicyStore } from "./retryPolicyStore.js";

export interface DlqTriageDeps {
  dlq: RedisStreamQueue;
  workQueue: RedisStreamQueue;
  escalationQueue: RedisStreamQueue;
  policyStore: RedisRetryPolicyStore;
  // Durable per-job resubmit counter, so the cap holds across triage runs and
  // processes, not just within one.
  redis: Redis;
  consumerName: string;
  maxResubmits?: number;
}

export type TriageOutcome =
  | { outcome: "empty" }
  | {
      outcome: "resubmitted" | "discarded" | "escalated";
      jobId: string;
      correlationId: string;
      failureClass: FailureClass;
      policyChanged: boolean;
      policyVersion: number;
    }
  | { outcome: "policy_update_failed"; jobId: string; correlationId: string; failureClass: FailureClass };

interface DlqPayload {
  originalPayload?: unknown;
  failureReason?: string;
  failedAt?: string;
}

const RESUBMIT_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function triageNextDlqEntry(deps: DlqTriageDeps): Promise<TriageOutcome> {
  const entry = await deps.dlq.dequeueOne(deps.consumerName);
  if (!entry) return { outcome: "empty" };

  const payload = (entry.payload ?? {}) as DlqPayload;
  const failureReason = payload.failureReason ?? "unknown";
  const failureClass = classifyReason(failureReason);
  const { correlationId } = entry;

  logJson("info", {
    event: "dlq_entry_classified",
    correlationId,
    context: { jobId: entry.id, failureClass, failureReason },
  });

  let update;
  try {
    update = await deps.policyStore.update(failureClass, (policy) => deriveRuleUpdate(policy, failureClass), correlationId);
  } catch (error) {
    // Already logged as retry_policy_update_failed by the store. Put the entry
    // back exactly as it was so the next triage run sees it again.
    await deps.dlq.enqueue(entry);
    logJson("warn", {
      event: "dlq_entry_returned",
      correlationId,
      outcome: "failure",
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      context: { jobId: entry.id, failureClass, reason: "policy_update_failed" },
    });
    return { outcome: "policy_update_failed", jobId: entry.id, correlationId, failureClass };
  }

  const rule = update.policy.rules[failureClass];
  const action = await decideAction(rule.action, entry, deps);
  const base = { jobId: entry.id, correlationId, failureClass, policyChanged: update.changed, policyVersion: update.policy.version };

  if (action.kind === "retry") {
    const original: Job = {
      id: entry.id,
      correlationId,
      idempotencyKey: entry.idempotencyKey,
      payload: payload.originalPayload,
    };
    await deps.workQueue.enqueue(original);
    logJson("info", {
      event: "dlq_entry_resubmitted",
      correlationId,
      outcome: "success",
      context: { jobId: entry.id, failureClass, resubmitCount: action.resubmitCount, policyVersion: update.policy.version },
    });
    return { outcome: "resubmitted", ...base };
  }

  if (action.kind === "discard") {
    logJson("warn", {
      event: "dlq_entry_discarded",
      correlationId,
      outcome: "skipped",
      context: { jobId: entry.id, failureClass, failureReason, policyVersion: update.policy.version },
    });
    return { outcome: "discarded", ...base };
  }

  await deps.escalationQueue.enqueue(entry);
  logJson("warn", {
    event: "dlq_entry_escalated",
    correlationId,
    outcome: "skipped",
    context: { jobId: entry.id, failureClass, failureReason, why: action.why, policyVersion: update.policy.version },
  });
  return { outcome: "escalated", ...base };
}

type Action = { kind: "retry"; resubmitCount: number } | { kind: "discard" } | { kind: "escalate"; why: string };

async function decideAction(ruleAction: RuleAction, entry: Job, deps: DlqTriageDeps): Promise<Action> {
  if (ruleAction === "discard") return { kind: "discard" };
  if (ruleAction === "escalate") return { kind: "escalate", why: "policy_escalates_class" };

  const key = `relay:dlq-resubmits:${entry.idempotencyKey}`;
  const count = await deps.redis.incr(key);
  await deps.redis.expire(key, RESUBMIT_TTL_SECONDS);
  if (count > (deps.maxResubmits ?? 2)) {
    return { kind: "escalate", why: "resubmit_limit_reached" };
  }
  return { kind: "retry", resubmitCount: count };
}
