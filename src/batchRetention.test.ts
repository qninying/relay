// Batch retention setting: 30 days unless configured, and a bad value is
// refused at boot rather than guessed at.

import { describe, it, expect } from "vitest";
import { batchRetentionDaysFromEnv, DEFAULT_BATCH_RETENTION_DAYS, RetentionConfigError } from "./batchRetention.js";

describe("batchRetentionDaysFromEnv", () => {
  it("defaults to the 30-day policy and accepts an override", () => {
    expect(DEFAULT_BATCH_RETENTION_DAYS).toBe(30);
    expect(batchRetentionDaysFromEnv({})).toBe(30);
    expect(batchRetentionDaysFromEnv({ RELAY_BATCH_RETENTION_DAYS: "" })).toBe(30);
    expect(batchRetentionDaysFromEnv({ RELAY_BATCH_RETENTION_DAYS: "5" })).toBe(5);
    expect(batchRetentionDaysFromEnv({ RELAY_BATCH_RETENTION_DAYS: "365" })).toBe(365);
  });

  it.each(["0", "-1", "1.5", "abc", "366", "5d"])("refuses %j", (raw) => {
    expect(() => batchRetentionDaysFromEnv({ RELAY_BATCH_RETENTION_DAYS: raw })).toThrow(RetentionConfigError);
  });
});
