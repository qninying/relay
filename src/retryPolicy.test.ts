// Unit tests: the runbook table as code (classifier), the codified triage
// rules (deriveRuleUpdate), policy validation, and withReliability actually
// following the policy when a call fails (STORY-008 criterion 2).

import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyFailure, classifyReason } from "./failureClassifier.js";
import {
  INITIAL_POLICY,
  MAX_BASE_DELAY_MS,
  HISTORY_LIMIT,
  applyRuleUpdate,
  deriveRuleUpdate,
  parsePolicy,
  type RetryPolicy,
} from "./retryPolicy.js";
import { withReliability, UpstreamCallFailedError, UpstreamTimeoutError } from "./withReliability.js";

afterEach(() => vi.useRealTimers());

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyReason: the runbook's Step 2 table", () => {
  it.each([
    ["Upstream call failed after 3 attempt(s): Upstream call timed out after 1000ms.", "timeout"],
    ["Upstream call failed after 3 attempt(s): 400 Bad Request", "client_error"],
    ["Upstream call failed after 3 attempt(s): 401 Unauthorized", "client_error"],
    ["invalid input: company name missing", "client_error"],
    ["Upstream call failed after 3 attempt(s): 503 Service Unavailable", "upstream_error"],
    ["502 Bad Gateway", "upstream_error"],
    ["504 Gateway Timeout", "upstream_error"],
    ["review_queue_unavailable", "review_queue_unavailable"],
    ["the vendor returned a haiku instead of JSON", "unclassified"],
    ["", "unclassified"],
  ])("%s -> %s", (reason, expected) => {
    expect(classifyReason(reason)).toBe(expected);
  });

  it("classifies live errors by name, HTTP status, and wrapped cause", () => {
    expect(classifyFailure(new UpstreamTimeoutError(50))).toBe("timeout");
    expect(classifyFailure(httpError(422, "nope"))).toBe("client_error");
    expect(classifyFailure(httpError(500, "nope"))).toBe("upstream_error");
    expect(classifyFailure(new UpstreamCallFailedError(3, httpError(404, "x")))).toBe("client_error");
    expect(classifyFailure(new Error("something odd"))).toBe("unclassified");
    expect(classifyFailure("plain string 400")).toBe("client_error");
  });
});

describe("deriveRuleUpdate: codified triage rules", () => {
  it("client_error in the DLQ switches the class to discard (retrying bad input never helps)", () => {
    expect(deriveRuleUpdate(INITIAL_POLICY, "client_error")).toEqual({ action: "discard", maxAttempts: 1, baseDelayMs: 100 });
  });

  it("is a no-op once client_error is already discard (re-triaging is idempotent)", () => {
    const updated = applyRuleUpdate(INITIAL_POLICY, "client_error", deriveRuleUpdate(INITIAL_POLICY, "client_error")!, "c1");
    expect(deriveRuleUpdate(updated, "client_error")).toBeNull();
  });

  it("timeout / upstream_error double the base backoff, capped", () => {
    expect(deriveRuleUpdate(INITIAL_POLICY, "timeout")).toMatchObject({ action: "retry", maxAttempts: 3, baseDelayMs: 200 });
    let policy: RetryPolicy = INITIAL_POLICY;
    for (let i = 0; i < 20; i++) {
      const next = deriveRuleUpdate(policy, "upstream_error");
      if (!next) break;
      policy = applyRuleUpdate(policy, "upstream_error", next, `c${i}`);
    }
    expect(policy.rules.upstream_error.baseDelayMs).toBe(MAX_BASE_DELAY_MS);
    expect(deriveRuleUpdate(policy, "upstream_error")).toBeNull();
  });

  it("unclassified and review_queue_unavailable never change the policy (don't guess)", () => {
    expect(deriveRuleUpdate(INITIAL_POLICY, "unclassified")).toBeNull();
    expect(deriveRuleUpdate(INITIAL_POLICY, "review_queue_unavailable")).toBeNull();
  });

  it("applyRuleUpdate bumps the version and records who changed what, bounded", () => {
    const next = applyRuleUpdate(INITIAL_POLICY, "timeout", { action: "retry", maxAttempts: 3, baseDelayMs: 200 }, "corr-x");
    expect(next.version).toBe(2);
    expect(next.history.at(-1)).toMatchObject({ correlationId: "corr-x", failureClass: "timeout", from: { baseDelayMs: 100 }, to: { baseDelayMs: 200 } });
    expect(INITIAL_POLICY.version).toBe(1); // not mutated
    let policy = INITIAL_POLICY;
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) policy = applyRuleUpdate(policy, "timeout", policy.rules.timeout, `c${i}`);
    expect(policy.history).toHaveLength(HISTORY_LIMIT);
  });
});

describe("parsePolicy: stored policy is untrusted input", () => {
  it("accepts a valid policy and rejects corrupt or out-of-bounds ones", () => {
    expect(parsePolicy(INITIAL_POLICY)).not.toBeNull();
    expect(parsePolicy(null)).toBeNull();
    expect(parsePolicy({ ...INITIAL_POLICY, version: 0 })).toBeNull();
    expect(parsePolicy({ ...INITIAL_POLICY, history: "x" })).toBeNull();
    const { timeout: _omit, ...missingClass } = INITIAL_POLICY.rules;
    expect(parsePolicy({ ...INITIAL_POLICY, rules: missingClass })).toBeNull();
    expect(parsePolicy({ ...INITIAL_POLICY, rules: { ...INITIAL_POLICY.rules, timeout: { action: "retry", maxAttempts: 1000, baseDelayMs: 1 } } })).toBeNull();
    expect(parsePolicy({ ...INITIAL_POLICY, rules: { ...INITIAL_POLICY.rules, timeout: { action: "explode", maxAttempts: 1, baseDelayMs: 1 } } })).toBeNull();
  });
});

describe("withReliability follows the retry policy (criterion 2)", () => {
  const options = { timeoutMs: 1000, maxRetries: 4, baseDelayMs: 1, maxDelayMs: 60_000 };

  it("before triage, a 4xx is retried like everything else; after, it fails on the first attempt", async () => {
    const call = vi.fn().mockRejectedValue(httpError(400));
    await expect(withReliability(call, { ...options, retryPolicy: { ...INITIAL_POLICY, rules: { ...INITIAL_POLICY.rules, client_error: { action: "retry", maxAttempts: 3, baseDelayMs: 1 } } } })).rejects.toBeInstanceOf(UpstreamCallFailedError);
    expect(call).toHaveBeenCalledTimes(3);

    call.mockClear();
    const updated = applyRuleUpdate(INITIAL_POLICY, "client_error", deriveRuleUpdate(INITIAL_POLICY, "client_error")!, "c1");
    const error = await withReliability(call, { ...options, retryPolicy: updated }).catch((e) => e);
    expect(call).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ attempts: 1, policy: { failureClass: "client_error", version: 2 } });
  });

  it("uses the updated backoff for the class that failed", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(httpError(503));
    const policy = applyRuleUpdate(INITIAL_POLICY, "upstream_error", { action: "retry", maxAttempts: 3, baseDelayMs: 400 }, "c1");
    const result = withReliability(call, { ...options, retryPolicy: policy }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(call).toHaveBeenCalledTimes(1); // old base (100ms) would have retried by now
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(800); // 400 * 2^1
    expect(call).toHaveBeenCalledTimes(3);
    expect(await result).toMatchObject({ attempts: 3, policy: { failureClass: "upstream_error" } });
  });

  it("an unclassified (escalate) failure is still retried live, same as before STORY-008", async () => {
    const call = vi.fn().mockRejectedValue(new Error("weird"));
    const error = await withReliability(call, { ...options, retryPolicy: INITIAL_POLICY }).catch((e) => e);
    expect(call).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ policy: { failureClass: "unclassified" } });
  });

  it("the initial policy reproduces pre-STORY-008 retry counts for every class", async () => {
    const failures = [new UpstreamTimeoutError(5), httpError(400), httpError(503), new Error("review_queue_unavailable"), new Error("weird")];
    for (const failure of failures) {
      const call = vi.fn().mockRejectedValue(failure);
      await withReliability(call, { ...options, maxRetries: 2, retryPolicy: INITIAL_POLICY }).catch(() => undefined);
      expect(call).toHaveBeenCalledTimes(3);
    }
  });

  it("maxRetries stays the hard ceiling even if the policy allows more", async () => {
    const call = vi.fn().mockRejectedValue(new UpstreamTimeoutError(5));
    const generous = applyRuleUpdate(INITIAL_POLICY, "timeout", { action: "retry", maxAttempts: 6, baseDelayMs: 1 }, "c1");
    await withReliability(call, { ...options, maxRetries: 1, retryPolicy: generous }).catch(() => undefined);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("without a policy, behavior is exactly as before STORY-008", async () => {
    const call = vi.fn().mockRejectedValue(httpError(400));
    await withReliability(call, { ...options, maxRetries: 2 }).catch(() => undefined);
    expect(call).toHaveBeenCalledTimes(3);
  });
});
