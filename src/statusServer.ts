// STORY-010: the production HTTP surface. Read-only by design: nothing here
// accepts jobs or changes state, so a public URL exposes counts, never job
// content, and has nothing to abuse. Jobs are submitted from inside the
// deployment (src/submitJobs.ts over `fly ssh console`), not over HTTP.
//
// Routes:
//   GET /health            liveness only, no dependencies (Fly's check)
//   GET /health/ready      Redis reachable? 200 / 503
//   GET / , /status        plain-language status page (REQ-013)
//   GET /status.json       same report plus the raw latest sample
//   GET /metrics/history   samples over time, ?hours=1..168 (REQ-014)
//   GET /dashboard         STORY-005's operator dashboard
//   GET /metrics           its JSON feed (rolling SLO snapshot + DLQ depth)

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Redis } from "ioredis";
import type { MetricsCollector } from "./metrics.js";
import type { MonitoringSampler } from "./monitoringSampler.js";
import { buildStatus, renderStatusHtml } from "./statusView.js";
import { logJson } from "./logger.js";

const DASHBOARD_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html");

export interface StatusServerDeps {
  redis: Redis;
  sampler: MonitoringSampler;
  metrics: MetricsCollector;
  sampleIntervalMs: number;
  targetSuccessRate: number;
  dlqStream: string;
  now?: () => number;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json", JSON.stringify(body));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export function createStatusServer(deps: StatusServerDeps): http.Server {
  const now = deps.now ?? Date.now;
  const report = () => {
    const { sample, error } = deps.sampler.latest();
    return {
      report: buildStatus({ sample, error, now: now(), sampleIntervalMs: deps.sampleIntervalMs, targetSuccessRate: deps.targetSuccessRate }),
      sample,
      error,
    };
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "Read-only: GET only.");

    const handle = async () => {
      switch (url.pathname) {
        case "/health":
          return json(res, 200, { ok: true });
        case "/health/ready":
          try {
            await withTimeout(deps.redis.ping(), 2000);
            return json(res, 200, { ok: true, redis: "reachable" });
          } catch {
            return json(res, 503, { ok: false, redis: "unreachable" });
          }
        case "/":
        case "/status":
          return send(res, 200, "text/html; charset=utf-8", renderStatusHtml(report().report));
        case "/status.json": {
          const body = report();
          return json(res, body.report.state === "down" ? 503 : 200, body);
        }
        case "/metrics/history": {
          const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours")) || 24));
          try {
            const samples = await withTimeout(deps.sampler.history(now() - hours * 3_600_000), 5000);
            return json(res, 200, { hours, count: samples.length, samples });
          } catch {
            return json(res, 503, { error: "monitoring history unavailable" });
          }
        }
        case "/dashboard":
          return send(res, 200, "text/html; charset=utf-8", await readFile(DASHBOARD_HTML, "utf-8"));
        case "/metrics": {
          const dlqDepth = await withTimeout(deps.redis.xlen(deps.dlqStream), 2000).catch(() => null);
          return json(res, 200, { ...deps.metrics.snapshot(), dlqDepth });
        }
        default:
          return send(res, 404, "text/plain", "Not found.");
      }
    };

    handle().catch((error) => {
      logJson("error", {
        event: "status_request_failed",
        correlationId: "http",
        outcome: "failure",
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        context: { path: url.pathname },
      });
      if (!res.headersSent) send(res, 500, "text/plain", "Internal error.");
    });
  });
}
