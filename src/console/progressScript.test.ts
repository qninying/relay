// STORY-105: the polling script, run against a fake page, clock and fetch
// (no browser in this suite): counts update in place, polling pauses while
// the tab is hidden, backs off on errors, and stops when the batch is
// finished or the session has ended.

import { describe, it, expect } from "vitest";
import { PROGRESS_SCRIPT } from "./batchDetail.js";

type Reply = { status: number; body?: unknown } | "network-error";

function harness(replies: Reply[], finished = false) {
  const els: Record<string, { textContent: string; getAttribute?: (n: string) => string }> = {
    progress: { textContent: "", getAttribute: (n) => (n === "data-src" ? "/console/api/batches/b123456/progress" : String(finished)) },
    "progress-note": { textContent: "" },
    "count-done": { textContent: "0" },
    "count-waiting": { textContent: "3" },
    "count-review": { textContent: "0" },
    "count-failed": { textContent: "0" },
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const listeners: Record<string, () => void> = {};
  const fetched: string[] = [];
  const document = { hidden: false, getElementById: (id: string) => els[id] ?? null, addEventListener: (e: string, fn: () => void) => (listeners[e] = fn) };
  const fetch = async (url: string) => {
    fetched.push(url);
    const r = replies.shift() ?? { status: 200, body: { done: 0, waiting: 3, review: 0, failed: 0, finished: false } };
    if (r === "network-error") throw new TypeError("Failed to fetch");
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  const setTimeout = (fn: () => void, ms: number) => timers.push({ fn, ms });
  new Function("document", "window", "fetch", "setTimeout", PROGRESS_SCRIPT)(document, { fetch }, fetch, setTimeout);
  const settle = () => new Promise((r) => globalThis.setTimeout(r, 0));
  // Runs the next scheduled poll and lets its fetch chain finish.
  const tick = async () => {
    const t = timers.shift();
    if (!t) return null;
    t.fn();
    await settle();
    return t.ms;
  };
  return { els, timers, fetched, document, listeners, tick, settle };
}

describe("progress.js", () => {
  it("updates the counts in place every 5 seconds and stops once the batch is finished", async () => {
    const h = harness([
      { status: 200, body: { done: 1, waiting: 1, review: 1, failed: 0, finished: false } },
      { status: 200, body: { done: 1500, waiting: 0, review: 1, failed: 1, finished: true } },
    ]);
    expect(await h.tick()).toBe(5000);
    expect(h.els["count-done"].textContent).toBe("1");
    expect(h.els["count-review"].textContent).toBe("1");
    expect(await h.tick()).toBe(5000);
    expect(h.els["count-done"].textContent).toBe("1,500");
    expect(h.els["progress-note"].textContent).toContain("Finished");
    expect(h.timers).toHaveLength(0);
    expect(h.fetched).toEqual(["/console/api/batches/b123456/progress", "/console/api/batches/b123456/progress"]);
  });

  it("doesn't poll a batch that was already finished when the page loaded", () => {
    const h = harness([], true);
    expect(h.timers).toHaveLength(0);
  });

  it("pauses while the tab is hidden and resumes when it's shown", async () => {
    const h = harness([]);
    h.document.hidden = true;
    await h.tick();
    expect(h.fetched).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
    h.document.hidden = false;
    h.listeners.visibilitychange();
    await h.settle();
    expect(h.fetched).toHaveLength(1);
  });

  it("backs off on errors (10s, 20s, ... up to 60s) and returns to 5s after a success", async () => {
    const h = harness(["network-error", { status: 503 }, "network-error", "network-error", "network-error"]);
    const delays = [];
    for (let i = 0; i < 6; i++) delays.push(await h.tick());
    // The sixth poll succeeds: the note says so and the next poll is back to 5s.
    expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    expect(h.els["progress-note"].textContent).toContain("Updated");
    expect(await h.tick()).toBe(5000);
  });

  it("stops and says so when the session has ended (401)", async () => {
    const h = harness([{ status: 401 }]);
    await h.tick();
    expect(h.els["progress-note"].textContent).toContain("session has ended");
    expect(h.timers).toHaveLength(0);
  });
});
