// STORY-003: composes the circuit breaker, timeout/retry wrapper, and output
// validation into one function that demonstrates a real external API call
// end to end. This is what actually satisfies all 3 acceptance criteria
// together — closed breaker lets the call proceed (REQ-003), open breaker
// blocks it fail-fast, and whatever the call returns is validated against
// the declared schema before persisting (REQ-012), never after.

import { CircuitBreaker } from "./circuitBreaker.js";
import { withReliability, UpstreamCallFailedError, type ReliabilityOptions } from "./withReliability.js";
import { persistOutput } from "./persistOutput.js";
import { moveToDeadLetterQueue } from "./dlq.js";
import { logJson } from "./logger.js";
import type { JobOutputSchema } from "../guardrails/outputContractGuardrail.js";
import type { RedisStreamQueue } from "./queue.js";
import type { Job } from "./processJob.js";

export type CallResult =
  | { status: "persisted" }
  | { status: "validation_failed"; violations: string[] }
  | { status: "call_failed"; errorClass: string }
  | { status: "moved_to_dlq"; errorClass: string };

export async function callExternalApiAndPersist(
  apiCall: () => Promise<Record<string, unknown>>,
  schema: JobOutputSchema,
  correlationId: string,
  breaker: CircuitBreaker,
  reliabilityOptions: Omit<ReliabilityOptions, "circuitBreaker">,
  // Optional (STORY-004): when both are given, a job whose retries are
  // genuinely exhausted (UpstreamCallFailedError) moves to the DLQ instead
  // of just being reported as failed. A circuit-open rejection does NOT
  // move the job to the DLQ — the call was never even attempted, so this
  // isn't "retries exhausted," and the caller may reasonably retry once the
  // circuit's cooldown elapses.
  dlqOptions?: { job: Job; dlq: RedisStreamQueue }
): Promise<CallResult> {
  let output: Record<string, unknown>;
  try {
    output = await withReliability(apiCall, { ...reliabilityOptions, circuitBreaker: breaker });
  } catch (error) {
    const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";
    logJson("error", {
      event: "external_api_call_failed",
      correlationId,
      outcome: "failure",
      errorClass,
    });

    if (error instanceof UpstreamCallFailedError && dlqOptions) {
      await moveToDeadLetterQueue(dlqOptions.dlq, dlqOptions.job, error.message);
      return { status: "moved_to_dlq", errorClass };
    }

    return { status: "call_failed", errorClass };
  }

  return persistOutput(output, schema, correlationId);
}
