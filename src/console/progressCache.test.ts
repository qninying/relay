// STORY-105 failure path: many tabs polling one batch must not mean many
// full counts of it.

import { describe, it, expect } from "vitest";
import { ProgressCache } from "./progressCache.js";
import { BatchResults } from "../batchResults.js";
import type { Redis } from "ioredis";

describe("ProgressCache", () => {
  it("counts a batch once for 50 simultaneous polls, then again after the TTL", async () => {
    let clock = 0;
    let loads = 0;
    const cache = new ProgressCache(async (k) => `${k}:${++loads}`, 2000, 500, () => clock);
    const values = await Promise.all(Array.from({ length: 50 }, () => cache.get("b1")));
    expect(new Set(values)).toEqual(new Set(["b1:1"]));
    clock = 1999;
    expect(await cache.get("b1")).toBe("b1:1");
    clock = 2000;
    expect(await cache.get("b1")).toBe("b1:2");
    expect(loads).toBe(2);
  });

  it("does not keep a failed count, so the next poll retries", async () => {
    let fail = true;
    const cache = new ProgressCache(async () => {
      if (fail) throw new Error("redis down");
      return "ok";
    });
    await expect(cache.get("b1")).rejects.toThrow("redis down");
    fail = false;
    expect(await cache.get("b1")).toBe("ok");
  });

  it("holds at most maxEntries batches, dropping the oldest", async () => {
    let loads = 0;
    const cache = new ProgressCache(async (k) => `${k}:${++loads}`, 60_000, 2);
    await cache.get("a");
    await cache.get("b");
    await cache.get("c");
    expect(await cache.get("c")).toBe("c:3");
    expect(await cache.get("a")).toBe("a:4");
  });
});

describe("BatchResults.counts (STORY-105 trust: no item counted twice)", () => {
  it("counts an item once even when HSCAN returns it twice (Redis may, while rehashing)", async () => {
    const done = JSON.stringify({ status: "done" });
    const review = JSON.stringify({ status: "review" });
    const pages: Record<string, [string, string[]]> = {
      "0": ["7", ["b-1", done, "b-2", review]],
      "7": ["0", ["b-2", review, "b-3", done]],
    };
    const fake = { hscan: async (_k: string, cursor: string) => pages[cursor] } as unknown as Redis;
    expect(await new BatchResults(fake).counts("b")).toEqual({ done: 2, review: 1, failed: 0, rejected: 0, recorded: 3 });
  });
});
