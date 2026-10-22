// STORY-008 (REQ-015): the DLQ triage runbook's Step 2 table
// (docs/runbooks/DLQ_TRIAGE.md), as code. Classifies a failure, either a
// live error or a DLQ entry's failureReason string, into the failure modes
// the runbook names. Anything that doesn't match is "unclassified", which
// the policy escalates rather than guesses at (runbook Step 3).
//
// Deliberately imports nothing from withReliability.ts (which imports this),
// so timeouts are recognised by error name rather than instanceof.

import { REVIEW_FALLBACK_REASON } from "./reviewQueue.js";

export type FailureClass = "timeout" | "client_error" | "upstream_error" | "review_queue_unavailable" | "unclassified";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "timeout",
  "client_error",
  "upstream_error",
  "review_queue_unavailable",
  "unclassified",
];

const TIMEOUT = /timed out|timeout/i;
const CLIENT = /\b4\d\d\b|bad request|invalid input|unauthorized|forbidden|not found|unprocessable/i;
const UPSTREAM = /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|upstream error/i;

function fromStatus(status: number): FailureClass | null {
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500 && status < 600) return "upstream_error";
  return null;
}

export function classifyFailure(failure: unknown): FailureClass {
  if (failure instanceof Error) {
    if (failure.name === "UpstreamTimeoutError") return "timeout";
    const status = (failure as { status?: unknown }).status;
    if (typeof status === "number") {
      const byStatus = fromStatus(status);
      if (byStatus) return byStatus;
    }
    // UpstreamCallFailedError wraps the last attempt's error; classify that.
    if (failure.cause !== undefined && failure.cause !== failure) {
      const inner = classifyFailure(failure.cause);
      if (inner !== "unclassified") return inner;
    }
    return classifyReason(failure.message);
  }
  return classifyReason(String(failure));
}

// Order matters: "504 Gateway Timeout" is an upstream error that also says
// timeout, and the runbook treats both the same way (retry once healthy).
export function classifyReason(reason: string): FailureClass {
  if (reason === REVIEW_FALLBACK_REASON) return "review_queue_unavailable";
  if (UPSTREAM.test(reason)) return "upstream_error";
  if (TIMEOUT.test(reason)) return "timeout";
  if (CLIENT.test(reason)) return "client_error";
  return "unclassified";
}
