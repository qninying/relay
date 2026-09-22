# STORY-008 — Codify DLQ triage into retry policy

As a system, I want to codify DLQ triage into the retry policy, so that manual review is minimized.

**Release:** r3 · Advanced Job Processing (weeks 3–4)
**Owner:** System
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-015** (Functional, must) — The system must codify classified failure modes into the retry policy to automate DLQ triage.

## How to build it

Analyze DLQ entries and update retry policy based on triage results.

## Failure paths you must handle

- DLQ triage is not codified
- Retry policy is not updated
- Triage updates are not logged

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a DLQ entry, When it is triaged, Then the retry policy is updated
- [ ] Given the retry policy, When a job fails, Then it follows the updated policy
- [ ] Trust: DLQ triage updates are logged with correlation IDs

When every box above is ticked, stop and show the demo.
