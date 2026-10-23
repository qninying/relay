// STORY-108 (REQ-111): 24-hour trend charts as inline SVG, no chart library.
//
// Samples (one a minute, monitoringSampler.ts) are grouped into 30-minute
// buckets. A bucket with no samples (Relay was down, restarting or
// deploying) is a gap: drawn as a shaded band with the line broken, never
// bridged or filled with invented values. A bucket with samples but no
// value for a metric (no jobs finished, so no success rate) breaks the
// line too, without the band.
//
// Accessibility: each chart is role="img" with a title and a description
// stating the current value, the range and any gaps in words, and the
// numbers are in a table under it, so nothing depends on seeing the chart
// or telling colours apart.

import type { MetricsSample } from "../monitoringSampler.js";
import { esc } from "./layout.js";

export const BUCKET_MS = 30 * 60 * 1000;
export const BUCKETS = 48;

export interface Bucket {
  start: number;
  samples: number;
  value: number | null;
}

export interface Series {
  title: string;
  unit: (v: number) => string;
  buckets: Bucket[];
}

type Metric = { pick: (s: MetricsSample) => number | null; combine: "mean" | "max" | "sum" };

export const METRICS: Record<"successRate" | "p95" | "queueDepth" | "failed", Metric> = {
  successRate: { pick: (s) => (s.successRate === null ? null : s.successRate * 100), combine: "mean" },
  p95: { pick: (s) => (s.p95LatencyMs === null ? null : s.p95LatencyMs / 1000), combine: "max" },
  queueDepth: { pick: (s) => s.queueDepth, combine: "max" },
  failed: { pick: (s) => s.failed, combine: "sum" },
};

// The last BUCKETS buckets ending at `now`, oldest first.
export function bucketize(samples: MetricsSample[], metric: Metric, now: number): Bucket[] {
  const first = now - BUCKETS * BUCKET_MS;
  const groups: number[][] = Array.from({ length: BUCKETS }, () => []);
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const s of samples) {
    const i = Math.floor((Date.parse(s.at) - first) / BUCKET_MS);
    if (i < 0 || i >= BUCKETS) continue;
    counts[i] += 1;
    const v = metric.pick(s);
    if (v !== null && Number.isFinite(v)) groups[i].push(v);
  }
  return groups.map((values, i) => {
    let value: number | null = null;
    if (values.length) {
      if (metric.combine === "mean") value = values.reduce((a, b) => a + b, 0) / values.length;
      else if (metric.combine === "max") value = Math.max(...values);
      else value = values.reduce((a, b) => a + b, 0);
    }
    return { start: first + i * BUCKET_MS, samples: counts[i], value };
  });
}

const W = 600;
const H = 160;
const PAD = { left: 44, right: 8, top: 10, bottom: 22 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((c) => c >= v)!;
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

// Plain-language summary: now, range, gaps.
export function describe(series: Series): string {
  const values = series.buckets.filter((b) => b.value !== null).map((b) => b.value!);
  const gaps = series.buckets.filter((b) => b.samples === 0).length;
  if (!values.length) return `No ${series.title.toLowerCase()} data in the last 24 hours.`;
  const last = [...series.buckets].reverse().find((b) => b.value !== null)!;
  const parts = [`Latest (${hhmm(last.start)} UTC): ${series.unit(last.value!)}.`, `Range over 24 hours: ${series.unit(Math.min(...values))} to ${series.unit(Math.max(...values))}.`];
  if (gaps) parts.push(`No data for ${gaps * 30 >= 60 ? `${Math.round((gaps * 30) / 6) / 10} hours` : `${gaps * 30} minutes`} (${gaps} of ${BUCKETS} half-hours), shown as shaded gaps.`);
  return parts.join(" ");
}

export function renderChart(id: string, series: Series, fixedMax?: number): string {
  const values = series.buckets.filter((b) => b.value !== null).map((b) => b.value!);
  const max = fixedMax ?? niceMax(values.length ? Math.max(...values) : 0);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / BUCKETS;
  const x = (i: number) => PAD.left + step * (i + 0.5);
  const y = (v: number) => PAD.top + plotH - (Math.min(v, max) / max) * plotH;

  // Contiguous runs of values; a null bucket ends a run.
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  series.buckets.forEach((b, i) => {
    if (b.value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push([x(i), y(b.value)]);
  });
  if (run.length) runs.push(run);

  const fmt = (n: number) => n.toFixed(1);
  const lines = runs
    .map((r) => (r.length === 1 ? `<circle cx="${fmt(r[0][0])}" cy="${fmt(r[0][1])}" r="2.5" class="line-dot"/>` : `<polyline points="${r.map(([a, b]) => `${fmt(a)},${fmt(b)}`).join(" ")}" class="line"/>`))
    .join("");
  const gaps = series.buckets
    .map((b, i) => (b.samples === 0 ? `<rect x="${fmt(PAD.left + step * i)}" y="${PAD.top}" width="${fmt(step)}" height="${plotH}" class="gap"/>` : ""))
    .join("");
  const grid = [0, 0.5, 1]
    .map((f) => {
      const gy = PAD.top + plotH - f * plotH;
      return `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${fmt(gy)}" y2="${fmt(gy)}" class="grid"/><text x="${PAD.left - 6}" y="${fmt(gy + 4)}" text-anchor="end" class="axis">${esc(series.unit(max * f))}</text>`;
    })
    .join("");
  const start = series.buckets[0].start;
  const axis = [
    [PAD.left, "start", hhmm(start)],
    [PAD.left + plotW / 2, "middle", hhmm(start + 12 * 3_600_000)],
    [W - PAD.right, "end", "now"],
  ]
    .map(([ax, anchor, label]) => `<text x="${ax}" y="${H - 6}" text-anchor="${anchor}" class="axis">${label}</text>`)
    .join("");
  const summary = describe(series);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-labelledby="${id}-t ${id}-d" class="chart"><title id="${id}-t">${esc(series.title)}, last 24 hours</title><desc id="${id}-d">${esc(summary)}</desc>${gaps}${grid}${lines}${axis}</svg>
<p class="muted" style="margin:4px 0 0;font-size:14px">${esc(summary)}</p>`;
}

export function renderTable(series: Series[]): string {
  const head = series.map((s) => `<th scope="col">${esc(s.title)}</th>`).join("");
  const rows = series[0].buckets
    .map((b, i) => `<tr><th scope="row">${hhmm(b.start)}</th>${series.map((s) => `<td>${s.buckets[i].samples === 0 ? "no data" : s.buckets[i].value === null ? "none" : esc(s.unit(s.buckets[i].value!))}</td>`).join("")}</tr>`)
    .join("");
  return `<div style="overflow-x:auto"><table><caption class="muted" style="text-align:left;padding:4px 0">Each row is the half-hour starting at that time (UTC). "no data" means Relay recorded nothing then; "none" means nothing to measure (for example no jobs finished).</caption><thead><tr><th scope="col">From</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
