import { describe, it, expect } from "vitest";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";

describe("InMemoryIdempotencyStore", () => {
  it("claims a new key the first time (happy path)", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("job-1")).toBe(true);
  });

  it("refuses the same key on a second claim (duplicate/re-delivery)", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("job-1");
    expect(store.claim("job-1")).toBe(false);
  });

  it("refuses on every call after the first, not just the second", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("job-1");
    expect(store.claim("job-1")).toBe(false);
    expect(store.claim("job-1")).toBe(false);
    expect(store.claim("job-1")).toBe(false);
  });

  it("treats different keys independently", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("job-1")).toBe(true);
    expect(store.claim("job-2")).toBe(true);
    expect(store.claim("job-1")).toBe(false);
  });

  it("treats an empty string as a valid, distinct key (boundary)", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("")).toBe(true);
    expect(store.claim("")).toBe(false);
  });
});
