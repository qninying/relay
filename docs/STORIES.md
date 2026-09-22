# Relay: AI Agent Job Orchestration Platform — Stories

12 stories across 5 releases, walking-skeleton first:
the earliest release proves the thinnest end-to-end path including the trust
spine, and later releases stack features on top of something already working.

## Before the releases — start here

- **[STORY-000](stories/STORY-000.md)** — Build your Command Center

The first thing you build, on day one, before any part of the system itself. It is
the page you keep open for the rest of the programme and demo from. It belongs to no
release and fulfils none of your requirements, because it is the window onto your
system rather than a part of it.

## r0 · Initial Skeleton — weeks 0–1

**Goal:** Establish the core job queue and processing reliability.
**Done when you can show:** Show a job processed end-to-end with idempotency and logging in place.

- **[STORY-001](stories/STORY-001.md)** — Process a job with idempotency and logging
- **[STORY-002](stories/STORY-002.md)** — Process jobs with durable queue and logging

## r1 · External API Handling — weeks 1–2

**Goal:** Integrate external API calls with circuit breakers and fallback paths.
**Done when you can show:** Demonstrate a job processing with circuit breaker and fallback path active.

- **[STORY-003](stories/STORY-003.md)** — Handle API calls with circuit breaker and validation
- **[STORY-004](stories/STORY-004.md)** — Implement dead-letter queue with triage runbook _(waits on STORY-001)_

## r2 · Monitoring and Autoscaling — weeks 2–3

**Goal:** Implement SLO dashboard and autoscaling workers.
**Done when you can show:** Show live SLO metrics and autoscaling in action.

- **[STORY-005](stories/STORY-005.md)** — Display live SLO dashboard _(waits on STORY-003)_
- **[STORY-006](stories/STORY-006.md)** — Implement autoscaling for worker processes _(waits on STORY-003)_

## r3 · Advanced Job Processing — weeks 3–4

**Goal:** Implement DLQ triage and low-confidence routing.
**Done when you can show:** Show DLQ triage and low-confidence job routing to review queue.

- **[STORY-007](stories/STORY-007.md)** — Route low-confidence jobs to review queue _(waits on STORY-005)_
- **[STORY-008](stories/STORY-008.md)** — Codify DLQ triage into retry policy _(waits on STORY-005)_
- **[STORY-011](stories/STORY-011.md)** — Ensure classification runs against fixed taxonomy _(waits on STORY-008)_
- **[STORY-012](stories/STORY-012.md)** — Generate summaries grounded in source data _(waits on STORY-011)_

## r4 · Chaos Engineering and Final Deployment — weeks 4–5

**Goal:** Conduct chaos drills and finalize deployment to production.
**Done when you can show:** Survive chaos drills without data loss or duplicate processing.

- **[STORY-009](stories/STORY-009.md)** — Conduct chaos-engineering drills _(waits on STORY-007)_
- **[STORY-010](stories/STORY-010.md)** — Deploy with monitoring and status view _(waits on STORY-009)_
