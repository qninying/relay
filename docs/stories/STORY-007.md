# STORY-007 — Route low-confidence jobs to review queue

As a system, I want to route low-confidence jobs to a review queue, so that they are not auto-resolved.

**Release:** r3 · Advanced Job Processing (weeks 3–4)
**Owner:** System
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-010** (Functional, must) — The system must route low-confidence classifications to a review queue instead of the dead-letter queue.

## How to build it

Implement routing logic for low-confidence jobs to review queue.

## Failure paths you must handle

- Job does not route to review queue
- Review queue entry is not logged
- Low-confidence job is auto-resolved

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a low-confidence job, When it is processed, Then it is routed to the review queue
- [ ] Given a review queue, When a job is added, Then it is logged with a correlation ID
- [ ] Trust: Low-confidence jobs are logged with correlation IDs

When every box above is ticked, stop and show the demo.
