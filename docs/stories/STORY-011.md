# STORY-011 — Ensure classification runs against fixed taxonomy

As a system, I want to ensure classification runs against a fixed taxonomy, so that results are consistent and reliable.

**Release:** r3 · Advanced Job Processing (weeks 3–4)
**Owner:** System
**Blocked by:** STORY-008

## The requirement this satisfies

- **REQ-017** (Functional, must) — The system must ensure that classification runs against a fixed, pre-defined taxonomy for the domain.

## How to build it

Ensure classification tasks reference the fixed taxonomy and log the taxonomy version used.

## Failure paths you must handle

- Taxonomy not found
- Classification task fails
- Logging service unavailable

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a classification task, When it is executed, Then it uses the fixed taxonomy
- [ ] Given a classification task, When the taxonomy is unavailable, Then the task fails gracefully
- [ ] Trust: Given a classification task, Then its execution is logged with the taxonomy version

When every box above is ticked, stop and show the demo.
