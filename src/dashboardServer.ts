// STORY-005: a small local HTTP server exposing the live SLO dashboard —
// GET /metrics (a JSON snapshot straight from the running MetricsCollector,
// plus real DLQ depth when a provider is given) and GET / (the page that
// polls it). No framework: Node's built-in http module is enough for two
// routes, and avoids a dependency this story doesn't actually need.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { MetricsCollector } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = path.join(__dirname, "dashboard.html");

export interface DashboardServerOptions {
  // Injected, not hardcoded to a real Redis client: keeps this server unit
  // testable with no Redis dependency, while runDashboard.ts wires in the
  // real thing. Omitted or a rejected promise both surface as
  // dlqDepth: null on the wire — "not connected," never a fabricated 0.
  getDlqDepth?: () => Promise<number>;
}

export function createDashboardServer(
  collector: MetricsCollector,
  options: DashboardServerOptions = {}
): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/metrics") {
      // Reads collector.snapshot() fresh on every request — nothing is
      // cached, so this reflects whatever has been recorded up to this
      // exact instant (criterion 1: updated live).
      const snapshot = collector.snapshot();
      const dlqDepthPromise = options.getDlqDepth ? options.getDlqDepth().catch(() => null) : Promise.resolve(null);

      dlqDepthPromise.then((dlqDepth) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...snapshot, dlqDepth }));
      });
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      readFile(DASHBOARD_HTML_PATH, "utf-8")
        .then((html) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
        })
        .catch(() => {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Dashboard page not found.");
        });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found.");
  });
}
