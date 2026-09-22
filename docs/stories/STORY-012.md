# STORY-012 — Generate summaries grounded in source data

As a system, I want to generate summaries grounded in source data, so that they are accurate and verifiable.

**Release:** r3 · Advanced Job Processing (weeks 3–4)
**Owner:** System
**Blocked by:** STORY-011

## The requirement this satisfies

- **REQ-016** (Functional, must) — The system must ensure that summaries are grounded strictly in the source data pulled for each item.

## How to build it

Ensure summaries are generated using the source data and log the data used for verification.

## Failure paths you must handle

- Source data unavailable
- Summary generation fails
- Logging service unavailable

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a summary is generated, When source data is available, Then it is grounded in that data
- [ ] Given a summary is generated, When source data is missing, Then the summary generation fails
- [ ] Trust: Given a summary is generated, Then its source data is logged for verification

When every box above is ticked, stop and show the demo.
