import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "./dashboardServer.js";
import { MetricsCollector } from "./metrics.js";

describe("dashboard HTTP server", () => {
  let server: ReturnType<typeof createDashboardServer>;
  let baseUrl: string;
  let collector: MetricsCollector;

  beforeAll(async () => {
    collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });
    server = createDashboardServer(collector);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves a JSON snapshot at /metrics reflecting the collector's current state, no restart needed (criterion 1: updated live)", async () => {
    const before = await fetch(`${baseUrl}/metrics`).then((r) => r.json());
    expect(before.totalRequests).toBe(0);
    expect(before.successRate).toBeNull();

    collector.record("success", 50, "corr-1");

    const after = await fetch(`${baseUrl}/metrics`).then((r) => r.json());
    expect(after.totalRequests).toBe(1);
    expect(after.successRate).toBe(1);
  });

  it("reflects a failure in the error budget served at /metrics (criterion 2)", async () => {
    collector.record("failure", 60, "corr-2");
    const snapshot = await fetch(`${baseUrl}/metrics`).then((r) => r.json());
    expect(snapshot.errorBudget.actualFailures).toBeGreaterThan(0);
  });

  it("serves the dashboard HTML page at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("RELAY");
    expect(html).toContain("/metrics");
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("reports dlqDepth as null when no provider was given (not connected, not a fabricated 0)", async () => {
    const snapshot = await fetch(`${baseUrl}/metrics`).then((r) => r.json());
    expect(snapshot.dlqDepth).toBeNull();
  });
});

describe("dashboard HTTP server with a DLQ depth provider", () => {
  it("includes the real DLQ depth in the /metrics response when a provider is given", async () => {
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });
    const server = createDashboardServer(collector, { getDlqDepth: async () => 7 });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const snapshot = await fetch(`http://127.0.0.1:${address.port}/metrics`).then((r) => r.json());
    expect(snapshot.dlqDepth).toBe(7);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("falls back to dlqDepth: null, not a 500, when the provider rejects", async () => {
    const collector = new MetricsCollector({ windowSize: 10, targetSuccessRate: 0.99 });
    const server = createDashboardServer(collector, {
      getDlqDepth: async () => {
        throw new Error("redis unavailable");
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(res.status).toBe(200);
    const snapshot = await res.json();
    expect(snapshot.dlqDepth).toBeNull();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
