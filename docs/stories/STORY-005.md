# STORY-005 — Display live SLO dashboard

As a user, I want to see a live SLO dashboard, so that I can monitor system performance.

**Release:** r2 · Monitoring and Autoscaling (weeks 2–3)
**Owner:** User
**Blocked by:** STORY-003

## The requirement this satisfies

- **REQ-006** (Functional, must) — The system must display a live SLO dashboard with a real error budget, showing metrics like job success rate and p95 job latency.
- **REQ-018** (Functional, must) — The system must provide an SLO dashboard as the ongoing check for system performance.

## How to build it

Implement SLO dashboard with live metrics display.

## Failure paths you must handle

- Dashboard fails to update
- Metrics are inaccurate
- Error budget is not tracked

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given the system, When jobs are processed, Then SLO metrics are updated live
- [ ] Given the SLO dashboard, When an error occurs, Then it is reflected in the error budget
- [ ] Trust: SLO metrics are logged with correlation IDs

When every box above is ticked, stop and show the demo.
