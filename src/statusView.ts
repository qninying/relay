// STORY-010 (REQ-013): the plain-language status view for RevOps and
// research-ops analysts. Pure: takes the latest monitoring sample (or the
// monitoring error) and returns sentences a non-engineer can act on, plus a
// small HTML page around them. No jargon (no "p95", "DLQ", "backlog") in
// what analysts read; the JSON endpoint keeps the precise numbers.
//
// Honesty rules, which are also the story's failure paths:
// - Monitoring unavailable: says so, shows no numbers as if current.
// - Status not updated: if the newest sample is older than 3 intervals, the
//   page says the numbers are stale and how old they are.
// - No data yet: says so, never shows a made-up 100%.

import type { MetricsSample } from "./monitoringSampler.js";

export type StatusState = "ok" | "attention" | "down" | "unknown";

export interface StatusInput {
  sample: MetricsSample | null;
  error: { at: string; errorClass: string } | null;
  now: number;
  sampleIntervalMs: number;
  targetSuccessRate: number;
}

export interface StatusReport {
  state: StatusState;
  headline: string;
  details: string[];
  updated: string;
  stale: boolean;
}

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

function duration(ms: number): string {
  if (ms < 1000) return "under a second";
  if (ms < 60_000) return `about ${Math.round(ms / 100) / 10} seconds`;
  if (ms < 3_600_000) return `about ${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;
  return `about ${Math.round(ms / 360_000) / 10} hours`;
}

function jobs(n: number): string {
  return `${n} job${n === 1 ? "" : "s"}`;
}

export function buildStatus(input: StatusInput): StatusReport {
  const { sample, error, now } = input;

  if (error) {
    return {
      state: "down",
      headline: "Relay can't reach its job queue right now.",
      details: [
        "While this lasts, new work can't be picked up and finished work can't be recorded.",
        "Monitoring is unavailable too, so no numbers are shown rather than old ones.",
        "Jobs already submitted are kept on disk and will be processed once the queue is back. Please tell the engineering team if this lasts more than a few minutes.",
      ],
      updated: `Last check failed ${duration(now - Date.parse(error.at))} ago.`,
      stale: true,
    };
  }

  if (!sample) {
    return {
      state: "unknown",
      headline: "Relay has just started.",
      details: ["The first health check runs within a minute. Refresh shortly."],
      updated: "No checks yet.",
      stale: true,
    };
  }

  const ageMs = now - Date.parse(sample.at);
  const stale = ageMs > input.sampleIntervalMs * 3;
  const issues: string[] = [];
  const details: string[] = [];

  if (sample.workers === 0 && sample.queueDepth > 0) issues.push(`No workers are running, and ${jobs(sample.queueDepth)} are waiting.`);
  if (sample.successRate !== null && sample.successRate < input.targetSuccessRate) {
    issues.push(`Only ${pct(sample.successRate)} of recent jobs succeeded (target ${pct(input.targetSuccessRate)}).`);
  }
  if (sample.dlqDepth > 0) issues.push(`${jobs(sample.dlqDepth)} failed after every retry and are waiting for an engineer to look at them.`);

  details.push(`${sample.workers} worker${sample.workers === 1 ? " is" : "s are"} running.`);
  details.push(
    sample.queueDepth === 0 ? "Nothing is waiting to start." : `${jobs(sample.queueDepth)} ${sample.queueDepth === 1 ? "is" : "are"} waiting to start.`
  );
  if (sample.successRate === null) {
    details.push("No jobs have finished recently, so there is no success rate to show yet.");
  } else {
    details.push(`${pct(sample.successRate)} of the last ${jobs(sample.windowJobs)} succeeded (target ${pct(input.targetSuccessRate)}).`);
  }
  if (sample.p95LatencyMs !== null) {
    details.push(`Most jobs (95 in 100) finish within ${duration(sample.p95LatencyMs)} of being submitted.`);
  }
  details.push(
    sample.reviewDepth === 0
      ? "No jobs are waiting for a person to review."
      : `${jobs(sample.reviewDepth)} ${sample.reviewDepth === 1 ? "is" : "are"} waiting for a person to review (a low-confidence classification, or a summary that didn't match its source).`
  );

  const updated = stale
    ? `These numbers are ${duration(ageMs)} old: the monitor has stopped updating, so treat them as out of date.`
    : `Updated ${duration(ageMs)} ago.`;

  if (stale) {
    return { state: "unknown", headline: "Relay's status is out of date.", details: [...issues, ...details], updated, stale };
  }
  if (issues.length) {
    return { state: "attention", headline: "Relay is running, but needs attention.", details: [...issues, ...details], updated, stale };
  }
  return { state: "ok", headline: "Relay is running normally.", details, updated, stale };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const STATE_LABEL: Record<StatusState, string> = { ok: "Running normally", attention: "Needs attention", down: "Not working", unknown: "Unknown" };

export function renderStatusHtml(report: StatusReport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Relay Status</title>
<style>
  :root { --bg:#f7f7f5; --card:#ffffff; --text:#1d1d1b; --muted:#5f5f5a; --ok:#1f7a4d; --attention:#a05a00; --down:#b3261e; --unknown:#5f5f5a; --border:#e3e3de; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --card:#1f1f1d; --text:#ececea; --muted:#a8a8a2; --ok:#5cc28d; --attention:#f0a64a; --down:#ff7b72; --unknown:#a8a8a2; --border:#33332f; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:640px; margin:0 auto; padding:32px 16px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px; }
  .badge { display:inline-flex; align-items:center; gap:8px; font-weight:600; font-size:14px; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--state); }
  h1 { font-size:22px; margin:12px 0 16px; }
  ul { padding-left:20px; margin:0; }
  li { margin:6px 0; }
  .updated { color:var(--muted); font-size:14px; margin-top:20px; }
</style>
</head>
<body>
<main>
  <div class="card" style="--state: var(--${report.state})">
    <span class="badge"><span class="dot"></span>${STATE_LABEL[report.state]}</span>
    <h1>${escapeHtml(report.headline)}</h1>
    <ul>
${report.details.map((d) => `      <li>${escapeHtml(d)}</li>`).join("\n")}
    </ul>
    <p class="updated">${escapeHtml(report.updated)} This page refreshes every 30 seconds.</p>
  </div>
</main>
</body>
</html>
`;
}
