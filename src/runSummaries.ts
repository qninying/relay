// STORY-012 demo: grounded summaries end to end with real Redis (source
// archive, review queue). The summarizer and the source fetch are stand-ins
// for the real LLM and scraper (neither is wired into Relay yet), scripted
// to show each outcome; the grounding check, archiving, review routing and
// verification are the real code. Needs `docker compose up -d redis`.

import { Redis } from "ioredis";
import { summarizeJob, verifySummary, type Summarizer } from "./summarizeJob.js";
import { RedisSourceArchive } from "./sourceArchive.js";
import { RedisStreamQueue } from "./queue.js";

const SOURCES: Record<string, string> = {
  acme: "Acme Logistics operates 42 warehouses across Texas and Oklahoma, offering freight forwarding, cold storage and last-mile delivery for regional grocery chains.",
  riverside: "Riverside Health runs three outpatient clinics in Tulsa and employs 120 nurses. It opened its newest clinic in 2023.",
  northwind: "Northwind sells payroll software to small accounting firms and reports 900 customers.",
};

// Scripted stand-in: one faithful summary, one with an invented number, one
// that drifts into marketing copy.
const SUMMARIES: Record<string, string> = {
  acme: "Acme Logistics operates 42 warehouses in Texas and Oklahoma, offering freight forwarding, cold storage and last-mile delivery for grocery chains.",
  riverside: "Riverside Health runs three outpatient clinics in Tulsa and employs 450 nurses.",
  northwind: "An innovative, fast-growing leader transforming the future of finance with cutting-edge solutions.",
};

async function main() {
  const redis = new Redis({ connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 2 });
  const reviewKey = "relay:demo:summary-review";
  await redis.del(reviewKey);
  const archive = new RedisSourceArchive(redis, "relay:demo:source:");
  const reviewQueue = new RedisStreamQueue(redis, reviewKey, "relay-review");
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  const out = (line: string) => process.stderr.write(`${line}\n`);
  const reliability = { timeoutMs: 1000, maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 };

  for (const id of [...Object.keys(SOURCES), "ghostco"]) {
    const job = { id, correlationId: `demo-sum-${id}`, idempotencyKey: `demo-sum-${id}`, payload: {} };
    const summarizer: Summarizer = async () => ({ summary: SUMMARIES[id] });
    const getSource = async () => (SOURCES[id] ? { sourceId: `https://example.com/${id}`, text: SOURCES[id] } : null);
    const r = await summarizeJob(job, summarizer, getSource, { reliability, archive, reviewQueue });
    if (r.status === "grounded") {
      const check = await verifySummary(r.summary, r.source.sha256, archive);
      out(`${id.padEnd(10)} GROUNDED  overlap ${r.overlapRatio.toFixed(2)}  source sha256 ${r.source.sha256.slice(0, 12)}  re-verified from archive: ${check.verified}`);
      out(`           "${r.summary}"`);
    } else if (r.status === "ungrounded") {
      out(`${id.padEnd(10)} REJECTED  ${r.violations.join(", ")}  overlap ${r.overlapRatio.toFixed(2)}  -> ${r.routedTo} queue`);
    } else {
      out(`${id.padEnd(10)} FAILED    ${r.reason} (summarizer never called)`);
    }
  }
  out(`\nreview queue: ${(await reviewQueue.peek(10)).map((e) => e.id).join(", ")}`);
  redis.disconnect();
}

main().catch((error) => {
  process.stderr.write(`summary demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
