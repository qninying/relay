# STORY-002 — Process jobs with durable queue and logging

As a system, I want to process jobs using a durable queue, so that job processing is reliable and traceable.

**Release:** r0 · Initial Skeleton (weeks 0–1)
**Owner:** System
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-001** (Constraint, must) — The system must use Redis Streams or SQS for the durable job queue.
- **REQ-011** (Functional, must) — The system must log low-confidence classifications with their correlation ID for traceability.

## How to build it

Use the existing job queue to process jobs and ensure logging includes correlation IDs for traceability.

## Failure paths you must handle

- Job not added to queue
- Job processing fails
- Logging service unavailable

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a job is submitted, When it is processed, Then it is logged with its correlation ID
- [ ] Given a job is processed, When it is low-confidence, Then it is logged with its correlation ID
- [ ] Trust: Given a job is processed, Then its processing is logged for traceability

When every box above is ticked, stop and show the demo.
