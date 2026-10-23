// STORY-108 (REQ-111): the console home is one overview: the same
// plain-language status as the public /status page (statusView.ts), plus
// 24-hour charts of success rate, p95 latency, queue depth and failed jobs.
//
// Honesty: when monitoring is unavailable or its newest sample is stale,
// the page says so first, in words, before any number (buildStatus decides
// this, as on /status). If the history can't be read in time, the charts
// are replaced by a sentence saying so; nothing old is shown as current.
// The state is shown as a symbol and a word, never colour alone.

import type { MetricsSample } from "../monitoringSampler.js";
import { buildStatus, STATE_LABEL, type StatusState } from "../statusView.js";
import type { Session } from "./auth/sessions.js";
import { esc, page } from "./layout.js";
import { bucketize, METRICS, renderChart, renderTable, type Series } from "./overviewCharts.js";
import type { ConsoleExtension, PageResult } from "./routes.js";
import { logJson } from "../logger.js";

export interface OverviewDeps {
  latest: () => { sample: MetricsSample | null; error: { at: string; errorClass: string } | null };
  history: (sinceMs: number) => Promise<MetricsSample[]>;
  sampleIntervalMs: number;
  targetSuccessRate: number;
  historyTimeoutMs?: number;
  now?: () => number;
}

const SYMBOL: Record<StatusState, string> = { ok: "✓", attention: "!", down: "✕", unknown: "?" };
const DAY_MS = 24 * 60 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");

export function overviewConsole(deps: OverviewDeps): ConsoleExtension {
  const now = deps.now ?? Date.now;

  async function render(session: Session): Promise<PageResult> {
    const at = now();
    const { sample, error } = deps.latest();
    const report = buildStatus({ sample, error, now: at, sampleIntervalMs: deps.sampleIntervalMs, targetSuccessRate: deps.targetSuccessRate });

    let charts: string;
    try {
      const samples = await withTimeout(deps.history(at - DAY_MS), deps.historyTimeoutMs ?? 3000);
      const series: Series[] = [
        { title: "Success rate", unit: (v) => `${n1(v)}%`, buckets: bucketize(samples, METRICS.successRate, at) },
        { title: "Slowest 5% of jobs (p95)", unit: (v) => `${n1(v)} s`, buckets: bucketize(samples, METRICS.p95, at) },
        { title: "Jobs waiting to start", unit: (v) => n1(v), buckets: bucketize(samples, METRICS.queueDepth, at) },
        { title: "Failed jobs", unit: (v) => n1(v), buckets: bucketize(samples, METRICS.failed, at) },
      ];
      charts = `${series.map((s, i) => `<h3 style="font-size:15px;margin:20px 0 6px">${esc(s.title)}</h3>${renderChart(`chart${i}`, s, i === 0 ? 100 : undefined)}`).join("")}
  <details style="margin-top:20px"><summary>Show the numbers</summary>${renderTable(series)}</details>`;
    } catch (err) {
      logJson("error", { event: "overview_history_unavailable", correlationId: session.username, outcome: "failure", errorClass: err instanceof Error ? err.constructor.name : "UnknownError", context: {} });
      charts = `<p role="alert">The 24-hour history can't be read right now, so no charts are shown. The status above is still the latest check.</p>`;
    }

    const warning = report.stale ? `<p class="error" role="alert">${esc(report.updated)}</p>` : `<p class="muted">${esc(report.updated)} Times are UTC.</p>`;
    return {
      status: 200,
      html: page({
        title: "Overview | Relay Console",
        session,
        body: `<div class="card">
  <p class="state state-${report.state}"><span aria-hidden="true" class="state-symbol">${SYMBOL[report.state]}</span> ${esc(STATE_LABEL[report.state])}</p>
  <h1>${esc(report.headline)}</h1>
  ${warning}
  <ul>${report.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
</div>
<div class="card" style="margin-top:16px">
  <h2 style="font-size:18px;margin:0">Last 24 hours</h2>
  <p class="muted" style="margin:4px 0 0">One point per half-hour. Shaded bands are times Relay recorded nothing (for example during a restart or deploy).</p>
  ${charts}
</div>`,
      }),
    };
  }

  return { getRoutes: [{ match: /^\/console$/, render: (session) => render(session) }] };
}
