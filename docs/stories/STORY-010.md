# STORY-010 — Deploy with monitoring and status view

As an operations team, I want to deploy the system with monitoring, so that I can track system health and provide status updates.

**Release:** r4 · Chaos Engineering and Final Deployment (weeks 4–5)
**Owner:** Operations Team
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-009** (Constraint, must) — The system must be deployed to a real production host.
- **REQ-013** (Functional, must) — The system must provide a plain-language status view for RevOps and research-ops analysts.
- **REQ-014** (Functional, must) — The system must track job success rate, p95 job latency, DLQ rate, circuit breaker trip frequency, and queue depth over time.

## How to build it

Deploy the system to the production host and ensure monitoring tracks job success rate, latency, and provides a status view.

## Failure paths you must handle

- Deployment fails
- Monitoring service unavailable
- Status view not updated

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given the system is deployed, When it is running, Then job success rate and latency are tracked
- [ ] Given the system is deployed, When a status request is made, Then a plain-language status view is provided
- [ ] Trust: Given the system is running, Then monitoring data is logged for auditability

When every box above is ticked, stop and show the demo.
