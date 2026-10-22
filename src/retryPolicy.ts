// STORY-008 (REQ-015): the retry policy, and the codified rules for how a
// triaged DLQ entry changes it. A policy is one rule per failure class
// (failureClassifier.ts): retry it (how many attempts, what base backoff),
// discard it, or escalate it to a human.
//
// INITIAL_POLICY is Relay's behavior before this story: every failure
// retried the same way. Triage then moves it toward the runbook's table as
// real DLQ entries are seen:
// - client_error in the DLQ: retrying a bad input can never succeed, so the
//   class switches to discard (runbook: "do not blindly resubmit").
// - timeout / upstream_error in the DLQ: retries ran out while the upstream
//   was unhealthy, so base backoff doubles to spread retries out, capped at
//   MAX_BASE_DELAY_MS so it can't grow without bound.
// - unclassified: no automatic change (runbook Step 3: don't guess).
// - review_queue_unavailable: an infrastructure blip, not a job problem; no
//   change.

import type { FailureClass } from "./failureClassifier.js";
import { FAILURE_CLASSES } from "./failureClassifier.js";

export type RuleAction = "retry" | "discard" | "escalate";

export interface ClassRule {
  action: RuleAction;
  maxAttempts: number;
  baseDelayMs: number;
}

export interface PolicyChange {
  correlationId: string;
  failureClass: FailureClass;
  from: ClassRule;
  to: ClassRule;
  at: string;
}

export interface RetryPolicy {
  version: number;
  rules: Record<FailureClass, ClassRule>;
  // Most recent changes, newest last, capped at HISTORY_LIMIT. Durable audit
  // trail alongside the logs, so who/what changed the policy survives even
  // if a log line is lost.
  history: PolicyChange[];
}

export const MAX_ATTEMPTS_CAP = 6;
export const MAX_BASE_DELAY_MS = 10_000;
export const HISTORY_LIMIT = 50;

const RETRY_DEFAULT: ClassRule = { action: "retry", maxAttempts: 3, baseDelayMs: 100 };

export const INITIAL_POLICY: RetryPolicy = {
  version: 1,
  rules: {
    timeout: { ...RETRY_DEFAULT },
    client_error: { ...RETRY_DEFAULT },
    upstream_error: { ...RETRY_DEFAULT },
    review_queue_unavailable: { ...RETRY_DEFAULT },
    unclassified: { action: "escalate", maxAttempts: 3, baseDelayMs: 100 },
  },
  history: [],
};

// The codified triage rules. Returns the class's new rule, or null when this
// failure mode doesn't change the policy (or the change is already in place).
export function deriveRuleUpdate(policy: RetryPolicy, failureClass: FailureClass): ClassRule | null {
  const current = policy.rules[failureClass];
  switch (failureClass) {
    case "client_error":
      if (current.action === "discard" && current.maxAttempts === 1) return null;
      return { action: "discard", maxAttempts: 1, baseDelayMs: current.baseDelayMs };
    case "timeout":
    case "upstream_error": {
      const next = Math.min(current.baseDelayMs * 2, MAX_BASE_DELAY_MS);
      if (next === current.baseDelayMs) return null;
      return { ...current, baseDelayMs: next };
    }
    case "unclassified":
    case "review_queue_unavailable":
      return null;
  }
}

export function applyRuleUpdate(
  policy: RetryPolicy,
  failureClass: FailureClass,
  to: ClassRule,
  correlationId: string
): RetryPolicy {
  const change: PolicyChange = { correlationId, failureClass, from: policy.rules[failureClass], to, at: new Date().toISOString() };
  return {
    version: policy.version + 1,
    rules: { ...policy.rules, [failureClass]: to },
    history: [...policy.history, change].slice(-HISTORY_LIMIT),
  };
}

// The policy is read back from Redis, so it's untrusted input: a hand-edited
// or corrupted value must be rejected, not used to drive retries.
export function parsePolicy(raw: unknown): RetryPolicy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<RetryPolicy>;
  if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1) return null;
  if (typeof candidate.rules !== "object" || candidate.rules === null || !Array.isArray(candidate.history)) return null;
  for (const cls of FAILURE_CLASSES) {
    const rule = (candidate.rules as Record<string, Partial<ClassRule> | undefined>)[cls];
    if (!rule || !["retry", "discard", "escalate"].includes(rule.action as string)) return null;
    if (!Number.isInteger(rule.maxAttempts) || (rule.maxAttempts as number) < 1 || (rule.maxAttempts as number) > MAX_ATTEMPTS_CAP) return null;
    if (typeof rule.baseDelayMs !== "number" || rule.baseDelayMs < 0 || rule.baseDelayMs > MAX_BASE_DELAY_MS) return null;
  }
  return candidate as RetryPolicy;
}

// What a failing call should do under this policy: how many attempts in
// total, and the base backoff. `action` is about what triage does once the
// job is in the DLQ; for live retries only discard matters, because it means
// triage has proven retrying this class can't succeed. escalate still
// retries live (an unknown error may well be transient), it just goes to a
// human rather than being resubmitted once it reaches the DLQ.
export function attemptsFor(policy: RetryPolicy, failureClass: FailureClass): ClassRule {
  const rule = policy.rules[failureClass];
  return rule.action === "discard" ? { ...rule, maxAttempts: 1 } : rule;
}
