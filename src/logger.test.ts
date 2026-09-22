import { describe, it, expect, vi, afterEach } from "vitest";
import { logJson } from "./logger.js";

describe("logJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single JSON line on stdout for info level (happy path)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logJson("info", { event: "job_received", correlationId: "corr-1", outcome: "success" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "info",
      service: "relay-core",
      event: "job_received",
      correlationId: "corr-1",
      outcome: "success",
    });
    expect(typeof parsed.timestamp).toBe("string");
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
  });

  it("routes error level to console.error, not console.log", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logJson("error", { event: "job_failed", correlationId: "corr-2", errorClass: "TimeoutError" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not throw and still emits a line when the context is circular (logging fails path)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      logJson("info", { event: "job_received", correlationId: "corr-3", context: circular })
    ).not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("log_serialization_failed");
    expect(parsed.correlationId).toBe("corr-3");
    expect(parsed.originalEvent).toBe("job_received");
  });

  it("threads the same correlation ID through multiple log calls for one job", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logJson("info", { event: "job_received", correlationId: "corr-4" });
    logJson("info", { event: "job_processed", correlationId: "corr-4", outcome: "success" });

    const ids = spy.mock.calls.map((call) => JSON.parse(call[0] as string).correlationId);
    expect(ids).toEqual(["corr-4", "corr-4"]);
  });
});
