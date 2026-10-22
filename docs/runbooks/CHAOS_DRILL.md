# Chaos Drill Runbook

For REQ-008 / STORY-009. How to run Relay's chaos-engineering drill, what it
proves, how to read the result, and what to do when it fails. The drill
itself is code (`src/chaosDrill.ts`); this page is how a person uses it.

## The hypothesis

> When worker processes are killed without warning while holding a job, and
> the queue is hit with a sudden backlog that includes duplicate submissions,
> every job is still processed **exactly once**: none lost, none duplicated,
> nothing left stuck.

The drill is designed so it can disprove this. It has been shown to fail
when the protection is removed (see "Proof the drill can fail" below), so a
pass means something.

## What makes the hypothesis true

| Protection | Where | What it prevents |
|---|---|---|
| Ack only after a job is handled | `src/workerLoop.ts` | A job taken by a worker that then dies is not marked done; it stays pending. |
| Reclaim stale work (`XAUTOCLAIM`) | `src/queue.ts` `reclaimStale()` | Pending work from a dead worker is taken over by a live one after `reclaimIdleMs`. |
| Shared idempotency store (Redis `SET NX`) | `src/idempotencyStore.ts` `RedisIdempotencyStore` | A job redelivered to a different worker, or submitted twice by a producer, is processed once and skipped after that. |
| Max deliveries | `src/workerLoop.ts` `deadLetterIfPoisoned()` | A job that keeps killing workers goes to the DLQ instead of looping forever. |
| Autoscaler / pool replaces dead workers | `src/processWorkerPool.ts`, `src/autoscaler.ts` | Capacity comes back after a crash. |

## Blast radius and safety

- **Local Redis only.** The drill refuses to run against any Redis host
  other than `localhost` / `127.0.0.1` / `::1` and logs
  `chaos_drill_refused`. Never point it at production.
- **Its own keys.** Everything lives under `relay:chaos:<drillId>`; no real
  queue, DLQ or idempotency keys are touched.
- **Always cleans up.** Workers are stopped and drill keys deleted in a
  `finally`, whether the drill passes, fails or throws.
- **Abort:** Ctrl+C. Any worker left behind can be found with
  `ps aux | grep workerProcess.ts`; leftover keys with
  `redis-cli --scan --pattern 'relay:chaos:*'`.

## How to run it

```bash
cd relay
docker compose up -d redis
cd src
npx tsx runChaosDrill.ts            # exits 0 only on PASS
npx tsx runChaosDrill.ts --verbose  # also prints every structured log line
```

### Drill A: crashed workers under a backlog (default)

120 jobs plus 20 duplicate submissions forced onto the queue before any
worker starts, 4 worker processes, 3 workers SIGKILLed while holding a job
(spread across the run, roughly a quarter, half and three-quarters of the
way through), each replaced immediately. Simulated work 40ms per job,
reclaim after 1s idle.

### Drill B: slow workers (aggressive reclaim)

```bash
DRILL_WORK_MS=100 DRILL_RECLAIM_IDLE_MS=20 DRILL_JOBS=60 npx tsx runChaosDrill.ts
```

Reclaim is set shorter than a job takes, so live-but-slow workers have
their jobs taken over mid-work. This is the "two workers end up holding the
same job" case; the shared idempotency store is what keeps it exactly-once.

Other settings: `DRILL_WORKERS`, `DRILL_KILLS`, `DRILL_DUPLICATES`,
`DRILL_TIMEOUT_MS`.

## Reading the result

```
  killed worker-ecf8bed1 (pid 51148) holding job 0  -> finished by another worker
  ...
  enqueued 140  unique 120  processed exactly once 120
  lost 0  duplicates 0  skipped as duplicate 20  reclaimed 3  pending after 0  dlq 0
  PASSED  in 2.2s   drill id chaos-d6b3f85f-...
```

- **processed exactly once** must equal **unique**.
- **lost** and **duplicates** must be 0.
- **skipped as duplicate** is good news: it's the idempotency store catching
  the duplicate submissions (and any redelivered job that had already been
  processed).
- **reclaimed** should be at least the number of kills.
- **finished by another worker** means a different worker handled the exact
  stream message the killed one held (matched by message id). That is the
  proof the kill landed mid-job and the job was recovered.
- **pending after** and **dlq** must be 0.

To see one job's full trail across workers, search the `--verbose` output
for its correlation ID (`<drillId>-job-<n>`). Drill events themselves
(`chaos_drill_started`, `chaos_backlog_forced`, `chaos_fault_injected`,
`chaos_worker_replaced`, `chaos_drill_completed` / `chaos_drill_failed`) all
carry the drill id as their correlation ID.

## When it fails

| Failure line | Likely cause | What to check |
|---|---|---|
| `N job(s) lost` | A job was acked before it was handled, or reclaim isn't running | `workerLoop.ts`: the ack must come after `routeJob`. Workers must call `reclaimStale` when idle. |
| `N job(s) processed more than once` | Idempotency claim isn't shared across workers | Worker processes must pass `durableStore` (`workerProcess.ts`). |
| `N message(s) still pending` | A job neither succeeded nor reached the DLQ before the timeout | Raise `DRILL_TIMEOUT_MS` first; if it persists, look for `worker_job_unplaced` / `job_poison_unplaced` lines. |
| `N killed worker(s) held a job no other worker reclaimed` | Kill didn't land mid-job, or reclaim never happened | Check `job_reclaimed` lines; check `reclaimIdleMs` vs the timeout. |
| `only N of M planned kills happened` | Workers finished the backlog before every kill | Raise `DRILL_JOBS` or `DRILL_WORK_MS`. |

A failed drill is a finding, not a flake: don't rerun until it passes.
Write down what failed, fix the protection, and add a test that reproduces
it.

## Proof the drill can fail

Recorded 2026-10-22 (session CC-20261022-3srn), on purpose, then reverted:

- **Ack on delivery** (the pre-STORY-009 behaviour): Drill A reported
  `lost 2 ... FAILED: 2 job(s) lost; 3 killed worker(s) held a job no other
  worker reclaimed`.
- **Per-process idempotency store** instead of the shared one: Drill B
  reported `duplicates 20 ... FAILED: 20 job(s) processed more than once`.

## Last results

| Date | Drill | Result |
|---|---|---|
| 2026-10-22 | A (120 jobs + 20 dupes, 4 workers, 3 kills) | PASS ×5: 0 lost, 0 duplicates, 3 reclaimed, 0 pending |
| 2026-10-22 | B (60 jobs + 20 dupes, reclaim 20ms < work 100ms) | PASS ×2: 0 lost, 0 duplicates, 5-6 reclaimed |

Add a row each time the drill is run for real, including failures.

## What this drill does not cover yet

- **Redis itself failing** (restart, failover, data loss). Relay's queue,
  DLQ, policy and idempotency store all live in one Redis; losing it is out
  of scope for this drill and for local dev. That belongs with the
  production deploy (STORY-010).
- **External API faults inside workers.** The worker loop doesn't make
  external calls yet; STORY-003/008's breaker and retry policy are tested
  separately.
- **Network partitions and clock skew** between workers.
- **The idempotency key is the commit point.** "Processing" today is the
  idempotency claim itself. When real side effects are added to workers,
  they must be keyed by the same idempotency key (or happen atomically with
  the claim), or a crash between claim and side effect would skip the side
  effect on redelivery. Re-run this drill when that changes.
