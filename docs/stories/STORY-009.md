# STORY-009 — Conduct chaos-engineering drills

As a system, I want to conduct chaos-engineering drills, so that system resilience is tested.

**Release:** r4 · Chaos Engineering and Final Deployment (weeks 4–5)
**Owner:** System
**Blocked by:** STORY-007

## The requirement this satisfies

- **REQ-008** (Functional, must) — The system must have a documented chaos-engineering drill to test system resilience.

## How to build it

Plan and execute chaos-engineering drills to test system resilience.

## Failure paths you must handle

- System fails during chaos drill
- Data is lost during drill
- Duplicate processing occurs

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a chaos drill, When a worker is killed mid-job, Then the system recovers without data loss
- [ ] Given a queue backlog, When it is forced, Then the system processes jobs without duplicates
- [ ] Trust: Chaos drill events are logged with correlation IDs

When every box above is ticked, stop and show the demo.
