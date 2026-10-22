// STORY-009: run the chaos drill (docs/runbooks/CHAOS_DRILL.md) and print a
// readable result. Exits 0 only if the drill passed. Local Redis only:
//   docker compose up -d redis
//   cd src && npx tsx runChaosDrill.ts
// Tunable via env: DRILL_JOBS, DRILL_DUPLICATES, DRILL_WORKERS, DRILL_KILLS,
// DRILL_WORK_MS, DRILL_RECLAIM_IDLE_MS, DRILL_TIMEOUT_MS. Pass --verbose to
// also print the drill's structured log lines.

import { Redis } from "ioredis";
import { fileURLToPath } from "node:url";
import { runChaosDrill } from "./chaosDrill.js";

const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

async function main(): Promise<number> {
  if (!process.argv.includes("--verbose")) {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
  }
  const out = (line: string) => process.stderr.write(`${line}\n`);
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { connectTimeout: 2000, commandTimeout: 5000, maxRetriesPerRequest: 2 });
  const config = {
    jobs: num("DRILL_JOBS", 120),
    duplicateEnqueues: num("DRILL_DUPLICATES", 20),
    workers: num("DRILL_WORKERS", 4),
    kills: num("DRILL_KILLS", 3),
    simulatedWorkMs: num("DRILL_WORK_MS", 40),
    reclaimIdleMs: num("DRILL_RECLAIM_IDLE_MS", 1000),
    timeoutMs: num("DRILL_TIMEOUT_MS", 60_000),
  };
  out(`chaos drill: ${config.jobs} jobs (+${config.duplicateEnqueues} duplicate enqueues) forced as a backlog, ${config.workers} worker processes, ${config.kills} SIGKILLs mid-job\n`);
  try {
    const r = await runChaosDrill(redis, fileURLToPath(new URL("./workerProcess.ts", import.meta.url)), config);
    for (const k of r.killed) {
      out(`  killed ${k.workerId} (pid ${k.pid}) holding ${k.inFlightJobId?.split("-job-")[1] ? `job ${k.inFlightJobId.split("-job-")[1]}` : "nothing"}  -> ${k.recoveredElsewhere ? "finished by another worker" : "not recovered elsewhere"}`);
    }
    out(`\n  enqueued ${r.enqueued}  unique ${r.uniqueJobs}  processed exactly once ${r.processedOnce}`);
    out(`  lost ${r.lost.length}  duplicates ${r.duplicates.length}  skipped as duplicate ${r.skippedAsDuplicate}  reclaimed ${r.reclaimed}  pending after ${r.pendingAfter}  dlq ${r.dlqDepth}`);
    out(`\n  ${r.passed ? "PASSED" : `FAILED: ${r.failures.join("; ")}`}  in ${(r.durationMs / 1000).toFixed(1)}s   drill id ${r.drillId}`);
    return r.passed ? 0 : 1;
  } finally {
    redis.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`chaos drill could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
);
