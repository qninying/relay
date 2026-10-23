// STORY-108: chart bucketing and SVG. Gaps after a restart are shown as
// gaps, never bridged with invented values.

import { describe, it, expect } from "vitest";
import { bucketize, BUCKET_MS, BUCKETS, describe as describeSeries, METRICS, renderChart, renderTable, type Series } from "./overviewCharts.js";
import type { MetricsSample } from "../monitoringSampler.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const START = NOW - BUCKETS * BUCKET_MS;

function sample(at: number, over: Partial<MetricsSample> = {}): MetricsSample {
  return { sampleId: "s", at: new Date(at).toISOString(), intervalMs: 60_000, successRate: 1, p95LatencyMs: 200, windowJobs: 10, processed: 1, failed: 0, movedToDlq: 0, dlqDepth: 0, routedToReview: 0, reviewDepth: 0, queueDepth: 0, pending: 0, workers: 1, breakerTrips: null, ...over };
}
// One sample a minute over [fromMs, toMs).
function minutes(fromMs: number, toMs: number, over: (t: number) => Partial<MetricsSample> = () => ({})): MetricsSample[] {
  const out: MetricsSample[] = [];
  for (let t = fromMs; t < toMs; t += 60_000) out.push(sample(t, over(t)));
  return out;
}

describe("bucketize", () => {
  it("averages success rate, takes the max p95 and queue depth, and sums failures per half-hour", () => {
    const s = [sample(START + 1000, { successRate: 0.9, p95LatencyMs: 100, queueDepth: 3, failed: 2 }), sample(START + 2000, { successRate: 0.7, p95LatencyMs: 900, queueDepth: 8, failed: 1 })];
    expect(bucketize(s, METRICS.successRate, NOW)[0]).toMatchObject({ samples: 2, value: 80 });
    expect(bucketize(s, METRICS.p95, NOW)[0].value).toBe(0.9);
    expect(bucketize(s, METRICS.queueDepth, NOW)[0].value).toBe(8);
    expect(bucketize(s, METRICS.failed, NOW)[0].value).toBe(3);
  });

  it("a half-hour with no samples is a gap (null, 0 samples); one with samples but no jobs is null with samples", () => {
    const b = bucketize([sample(START + 5 * BUCKET_MS + 10, { successRate: null })], METRICS.successRate, NOW);
    expect(b).toHaveLength(BUCKETS);
    expect(b[0]).toMatchObject({ samples: 0, value: null });
    expect(b[5]).toMatchObject({ samples: 1, value: null });
  });

  it("ignores samples outside the 24 hours", () => {
    const b = bucketize([sample(START - 1), sample(NOW + 1)], METRICS.queueDepth, NOW);
    expect(b.every((x) => x.samples === 0)).toBe(true);
  });
});

describe("renderChart", () => {
  // Data, then a 2-hour outage (4 half-hours), then data again.
  const outageFrom = START + 10 * BUCKET_MS;
  const outageTo = outageFrom + 4 * BUCKET_MS;
  const samples = [...minutes(START, outageFrom), ...minutes(outageTo, NOW)];
  const series: Series = { title: "Jobs waiting to start", unit: (v) => String(v), buckets: bucketize(samples, METRICS.queueDepth, NOW) };
  const svg = renderChart("c", series);

  it("shades each empty half-hour and breaks the line there instead of joining across it", () => {
    expect((svg.match(/class="gap"/g) ?? []).length).toBe(4);
    expect((svg.match(/<polyline /g) ?? []).length).toBe(2);
    // No line point falls inside the outage.
    const xs = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1].split(" ").map((p) => Number(p.split(",")[0])));
    const gapX = [...svg.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[1]) + Number(m[2])]);
    for (const x of xs) for (const [a, b] of gapX) expect(x <= a || x >= b).toBe(true);
  });

  it("is labelled for screen readers and says the gap in words", () => {
    expect(svg).toContain('role="img" aria-labelledby="c-t c-d"');
    expect(svg).toContain("<title id=\"c-t\">Jobs waiting to start, last 24 hours</title>");
    expect(describeSeries(series)).toContain("No data for 2 hours (4 of 48 half-hours), shown as shaded gaps.");
  });

  it("draws a lone value as a dot, and says when there's no data at all", () => {
    const lone: Series = { title: "Failed jobs", unit: String, buckets: bucketize([sample(START + 20 * BUCKET_MS + 5, { failed: 4 })], METRICS.failed, NOW) };
    expect(renderChart("d", lone)).toContain("<circle ");
    const empty: Series = { title: "Failed jobs", unit: String, buckets: bucketize([], METRICS.failed, NOW) };
    expect(describeSeries(empty)).toBe("No failed jobs data in the last 24 hours.");
  });

  it("the numbers table says 'no data' for gaps and 'none' for nothing to measure", () => {
    const t = renderTable([series, { title: "Success rate", unit: (v) => `${v}%`, buckets: bucketize(minutes(START, START + BUCKET_MS, () => ({ successRate: null })), METRICS.successRate, NOW) }]);
    expect(t).toContain('<tr><th scope="row">12:00</th><td>0</td><td>none</td></tr>');
    expect(t).toContain(`<tr><th scope="row">${new Date(outageFrom).toISOString().slice(11, 16)}</th><td>no data</td><td>no data</td></tr>`);
  });
});
