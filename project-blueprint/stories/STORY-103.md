# STORY-103: Classify each batch item in the workers and record its result

**Release:** r1, Batches In, Results Out
**Fulfills:** REQ-115
**Blocked by:** STORY-102
**Primary user:** System

## Story

As an analyst, I want every item I submit to come back with a real classification and status, so that a batch's results mean something.

## Acceptance criteria

- Given a job with a batch id and input text, When a worker handles it, Then it runs classifyJob against the fixed taxonomy and stores the label, confidence and taxonomy version under that batch
- Given a classification below the taxonomy's review threshold, When it is stored, Then the item is marked waiting for review and is in the review queue, not marked done
- Given the classifier fails or returns a label outside the taxonomy, When the worker handles it, Then the item is marked failed with the reason, and nothing is stored as a result
- Trust: each item's stored result is written once (idempotent per job), and a redelivered job never overwrites or double-counts it

## Known failure paths to handle

- Classifier adapter not configured or its API key missing at startup
- Classifier call hangs or rate-limits (timeout, capped retries, then failed, never a stuck worker)
- Batch counters drift from the per-item statuses after a worker crash mid-update

## Build guidance

Add a classifier adapter interface (stand-in keyword classifier and, if approved, a Claude API adapter selected by env var) and call src/classifyJob.ts from the worker path in src/jobRouter.ts / src/workerLoop.ts. Store per-item results in a Redis hash per batch and derive counts from item statuses rather than separate counters. Depends on the open decision about which classifier to use.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-103, Classify each batch item in the workers and record its result.

As an analyst, I want every item I submit to come back with a real classification and status, so that a batch's results mean something.

Before writing any code, confirm STORY-102 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given a job with a batch id and input text, When a worker handles it, Then it runs classifyJob against the fixed taxonomy and stores the label, confidence and taxonomy version under that batch
- Given a classification below the taxonomy's review threshold, When it is stored, Then the item is marked waiting for review and is in the review queue, not marked done
- Given the classifier fails or returns a label outside the taxonomy, When the worker handles it, Then the item is marked failed with the reason, and nothing is stored as a result
- Trust: each item's stored result is written once (idempotent per job), and a redelivered job never overwrites or double-counts it

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Classifier adapter not configured or its API key missing at startup
- Classifier call hangs or rate-limits (timeout, capped retries, then failed, never a stuck worker)
- Batch counters drift from the per-item statuses after a worker crash mid-update

Add a classifier adapter interface (stand-in keyword classifier and, if approved, a Claude API adapter selected by env var) and call src/classifyJob.ts from the worker path in src/jobRouter.ts / src/workerLoop.ts. Store per-item results in a Redis hash per batch and derive counts from item statuses rather than separate counters. Depends on the open decision about which classifier to use.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-103 named in a trailer, e.g. `Story: STORY-103`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
