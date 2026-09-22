# STORY-001 — Process a job with idempotency and logging

As a system, I want to process jobs idempotently, so that re-delivered jobs do not double-process.

**Release:** r0 · Initial Skeleton (weeks 0–1)
**Owner:** System
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-002** (Functional, must) — The system must ensure idempotent job processing to prevent double-processing of re-delivered jobs.
- **REQ-005** (Functional, must) — The system must provide structured JSON logging with correlation IDs threaded through queue, worker, and external call.

## How to build it

Implement job processing logic with idempotency checks and structured logging.

## Failure paths you must handle

- Job fails to process
- Job processes twice
- Logging fails

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a job in the queue, When it is processed, Then it is logged with a correlation ID
- [ ] Given a re-delivered job, When it is processed, Then it does not double-process
- [ ] Trust: All job processing is logged with correlation IDs

When every box above is ticked, stop and show the demo.
