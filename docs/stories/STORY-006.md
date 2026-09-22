# STORY-006 — Implement autoscaling for worker processes

As a system, I want to autoscale worker processes, so that job processing adapts to load.

**Release:** r2 · Monitoring and Autoscaling (weeks 2–3)
**Owner:** System
**Blocked by:** STORY-003

## The requirement this satisfies

- **REQ-007** (Functional, must) — The system must support multiple autoscaling worker processes.

## How to build it

Configure autoscaling for worker processes based on job queue depth.

## Failure paths you must handle

- Workers do not scale up
- Workers do not scale down
- Autoscaling fails to log

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given job load increases, When workers are needed, Then they are autoscaled
- [ ] Given job load decreases, When workers are not needed, Then they are scaled down
- [ ] Trust: Autoscaling events are logged with correlation IDs

When every box above is ticked, stop and show the demo.
