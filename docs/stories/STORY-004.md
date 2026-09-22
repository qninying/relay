# STORY-004 — Implement dead-letter queue with triage runbook

As a system, I want to use a dead-letter queue, so that failed jobs are managed and triaged.

**Release:** r1 · External API Handling (weeks 1–2)
**Owner:** System
**Blocked by:** STORY-001

## The requirement this satisfies

- **REQ-004** (Functional, must) — The system must have a dead-letter queue for jobs that exhaust retries, with a triage runbook.

## How to build it

Set up dead-letter queue and create triage runbook for failed jobs.

## Failure paths you must handle

- Job does not move to DLQ
- DLQ entry is not logged
- Triage runbook is incomplete

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a job, When retries are exhausted, Then it is moved to the dead-letter queue
- [ ] Given a dead-letter queue, When a job is triaged, Then it is logged with a reason
- [ ] Trust: Dead-letter queue entries are logged with correlation IDs

When every box above is ticked, stop and show the demo.
