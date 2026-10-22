# Deployment Runbook

For REQ-009 / REQ-013 / REQ-014, STORY-010. How Relay runs in production on
Fly.io, how to deploy, roll back, and check on it, and what it costs.

## What runs where

| Fly app | Machine | What it does |
|---|---|---|
| `relay-qn` | shared-cpu-1x, 512MB, `iad` | `src/server.ts`: the autoscaler and 1-3 worker processes, the monitoring sampler, and the public read-only status server. Exactly one machine (one autoscaler). |
| `relay-qn-redis` | shared-cpu-1x, 256MB, `iad`, 1GB volume | Redis 7.4 with a password, append-only persistence and `noeviction`. Private: no public address, reachable only at `relay-qn-redis.internal:6379`. Holds the job queue, review queue, DLQ, retry policy, idempotency keys and monitoring history. |

**Public URLs (read-only, no job content):**

| URL | For |
|---|---|
| `https://relay-qn.fly.dev/status` | Analysts: plain-language status (REQ-013) |
| `https://relay-qn.fly.dev/status.json` | The same report as JSON, plus the latest raw sample |
| `https://relay-qn.fly.dev/metrics/history?hours=24` | Success rate, p95 latency, DLQ, queue depth over time (REQ-014), up to 168 hours |
| `https://relay-qn.fly.dev/dashboard` | Engineers: STORY-005's live SLO dashboard |
| `https://relay-qn.fly.dev/health` | Liveness (Fly's health check) |
| `https://relay-qn.fly.dev/health/ready` | Readiness: can the app reach Redis? |

Nothing public accepts writes. Jobs are submitted from inside the deployment:

```bash
fly ssh console -a relay-qn -C "node dist/src/submitJobs.js 200"
fly ssh console -a relay-qn -C "node dist/src/submitJobs.js 200 --low-confidence 10"
```

## Cost (estimated, Oct 2026)

About **$6-8/month**: the 512MB app machine (~$3-4), the 256MB Redis
machine (~$2), the 1GB volume (~$0.15), light egress. Check
`fly dashboard` > Billing after the first week for the real figure, and
record it here.

## First-time setup

```bash
fly auth login              # once; opens a browser
./scripts/setup-fly.sh      # apps, volume, secrets, Redis deploy (idempotent)
./scripts/deploy.sh         # the app
```

`setup-fly.sh` generates a random Redis password and passes it straight to
`fly secrets set` for both apps (`REDIS_PASSWORD` on Redis, `REDIS_URL` on
the app). It is never printed or stored anywhere else.

## Routine deploy

```bash
./scripts/deploy.sh
```

It refuses to deploy unless the type-check and the full test suite pass
(against local Redis in Docker), remembers the currently running image,
deploys one machine, then smoke-checks the public URL: `/health/ready` must
return 200 and `/status.json` must not say `down`, within about 2 minutes.
If the deploy or the smoke check fails, it redeploys the previous image
and exits non-zero.

## Rollback by hand

```bash
fly releases -a relay-qn --image          # find the last good image
fly deploy -a relay-qn --image <image> --ha=false
```

A deploy never touches Redis, so rolling back the app loses no queued jobs.

## Checking on it

| Question | Command / URL |
|---|---|
| Is it up? | `/status`, or `fly status -a relay-qn` |
| What did it just do? | `fly logs -a relay-qn` (structured JSON; search by `correlationId`) |
| How many workers? | `/status`, or `autoscale_up` / `autoscale_down` in the logs |
| History of a metric | `/metrics/history?hours=24` |
| Is Redis OK? | `/health/ready`; `fly status -a relay-qn-redis` |
| Jobs needing a person | `/status` ("waiting for a person to review"); `docs/runbooks/DLQ_TRIAGE.md` for failed jobs |

Every monitoring sample is logged as `metrics_sample` with its own
correlation ID, and the stored sample carries the same `sampleId`, so any
number on the status page can be traced to a log line.

## Failure modes and what you'll see

| What happened | What the status page shows | What to do |
|---|---|---|
| Redis down or unreachable | "Relay can't reach its job queue right now", HTTP 503 on `/status.json` and `/health/ready`. `/health` stays 200, so Fly doesn't restart-loop the app. | `fly status -a relay-qn-redis`; `fly machine restart` on the Redis machine. Jobs already queued are on the volume. |
| Sampler stopped updating | "Relay's status is out of date" with the age of the numbers | `fly logs -a relay-qn` for `monitoring_sample_failed`; restart the app machine. |
| A deploy is bad | `deploy.sh` rolls back automatically | Read the smoke check output; fix; redeploy. |
| Success rate below 90% | "needs attention" with the rate | `fly logs` for `job_failed`; DLQ runbook. |
| Jobs failing for good | "N jobs failed after every retry..." | `docs/runbooks/DLQ_TRIAGE.md` |
| Redis memory full | Enqueue errors in the logs (`job_enqueue_failed`); existing jobs are kept (`noeviction`) | Drain or triage, then `fly scale memory` on the Redis app. |

## Rotating the Redis password

```bash
PASSWORD="$(openssl rand -hex 32)"
fly secrets set "REDIS_PASSWORD=$PASSWORD" -a relay-qn-redis
fly secrets set "REDIS_URL=redis://:$PASSWORD@relay-qn-redis.internal:6379" -a relay-qn
unset PASSWORD
```

The app reconnects on its own once both have restarted.

## Shutting it down

`fly scale count 0 -a relay-qn` stops the app (the public URL goes offline).
`fly apps destroy relay-qn relay-qn-redis` deletes everything, including the
volume and every queued job. Confirm before either.

## What this doesn't cover yet

- **Alerting.** Nothing pages anyone; problems are visible on the status page
  and in the logs only.
- **Circuit breaker trip frequency** is recorded as `null`: the worker path
  makes no external API calls yet, so there is no breaker in it to trip.
- **Redis is a single machine.** Its volume survives restarts and deploys,
  but there is no replica; losing the volume loses queued jobs.
- **No CI/CD.** Deploys run from a laptop via `deploy.sh` (still gated by the
  full test suite). A GitHub Actions workflow like CoreOps's would need a
  `FLY_API_TOKEN` repository secret.
