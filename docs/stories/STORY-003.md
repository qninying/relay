# STORY-003 — Handle API calls with circuit breaker and validation

As a system, I want to handle API calls with a circuit breaker, so that I can prevent cascading failures and ensure data integrity.

**Release:** r1 · External API Handling (weeks 1–2)
**Owner:** System
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-003** (Functional, must) — The system must implement a circuit breaker in front of every external API call with a documented fallback or fail-fast path.
- **REQ-012** (Functional, must) — The system must validate output against a declared JSON schema before persisting it.

## How to build it

Integrate a circuit breaker pattern for API calls and validate outputs against the JSON schema before persisting.

## Failure paths you must handle

- Circuit breaker fails to open
- Output validation fails
- API call times out

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an API call is made, When the circuit breaker is closed, Then the call proceeds
- [ ] Given an API call is made, When the circuit breaker is open, Then the call is blocked
- [ ] Trust: Given output is generated, Then it is validated against the JSON schema before persisting

When every box above is ticked, stop and show the demo.
