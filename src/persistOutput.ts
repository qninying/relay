// STORY-003's Trust criterion (REQ-012): output is validated against a
// declared JSON schema before persisting. Reuses the guardrail already built
// and tested for this exact purpose — guardrails/outputContractGuardrail.ts —
// rather than writing new validation logic; this is that guardrail's first
// real caller. No real database exists yet, so "persisting" here is a
// logged, honest stub, same scoping choice processJob.ts and queue.ts made
// for the pieces that don't exist yet.

import { logJson } from "./logger.js";
import { checkOutputContractGuardrail, type JobOutputSchema } from "../guardrails/outputContractGuardrail.js";

export type PersistResult =
  | { status: "persisted" }
  | { status: "validation_failed"; violations: string[] };

export function persistOutput(
  output: Record<string, unknown>,
  schema: JobOutputSchema,
  correlationId: string
): PersistResult {
  const check = checkOutputContractGuardrail(output, schema);

  if (!check.allowed) {
    logJson("warn", {
      event: "output_validation_failed",
      correlationId,
      outcome: "failure",
      context: { jobType: schema.jobType, violations: check.violations },
    });
    return { status: "validation_failed", violations: check.violations };
  }

  // Stub: no real persistence layer exists yet. Logged honestly as such so
  // nothing downstream mistakes this for a real write.
  logJson("info", {
    event: "output_persisted",
    correlationId,
    outcome: "success",
    context: { jobType: schema.jobType, stub: true },
  });
  return { status: "persisted" };
}
