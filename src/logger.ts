// Structured JSON logging with correlation IDs (REQ-005). One line per log call,
// threaded with the correlation ID the caller supplies — this module doesn't
// generate or store correlation IDs itself, since the whole point is that one ID
// flows unchanged from queue -> worker -> external call.
//
// Defensive against its own failure mode ("Logging fails" — one of STORY-001's
// named failure paths): JSON.stringify can throw on a circular payload, and a
// logging call must never crash the job it's describing. On that failure this
// still emits a line — just a fallback one saying logging itself broke — rather
// than throwing and silently losing the log.

export type LogLevel = "info" | "warn" | "error";
export type LogOutcome = "success" | "failure" | "skipped";

export interface LogFields {
  event: string;
  correlationId: string;
  outcome?: LogOutcome;
  durationMs?: number;
  errorClass?: string;
  context?: Record<string, unknown>;
}

function writeLine(level: LogLevel, line: Record<string, unknown>): void {
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export function logJson(level: LogLevel, fields: LogFields): void {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: "relay-core",
    ...fields,
  };
  try {
    writeLine(level, line);
  } catch (error) {
    // Fallback line carries only what's guaranteed serializable — never the
    // original context, which is presumably what broke JSON.stringify.
    writeLine("error", {
      timestamp: new Date().toISOString(),
      level: "error",
      service: "relay-core",
      event: "log_serialization_failed",
      correlationId: fields.correlationId,
      errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
      originalEvent: fields.event,
    });
  }
}
