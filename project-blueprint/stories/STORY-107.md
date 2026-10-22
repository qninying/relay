# STORY-107: Resubmit or discard failed jobs

**Release:** r2, Humans in the Loop
**Fulfills:** REQ-110
**Blocked by:** STORY-102
**Primary user:** Engineer

## Story

As an engineer, I want to see the failed jobs that need a person and resubmit or discard them, so that nothing sits in the escalation stream forgotten.

## Acceptance criteria

- Given escalated failed jobs, When I open the failed jobs page, Then I see each one's failure reason, class and how long it has waited
- Given I resubmit one, When I confirm, Then it is enqueued again with its original idempotency key and leaves the list
- Given I discard one, When I confirm with a required note, Then it is recorded as discarded and leaves the list
- Trust: only engineers can resubmit or discard (analysts see the page read-only), and every action is audited

## Known failure paths to handle

- Resubmitting a job whose original actually succeeded (idempotency key must stop a duplicate)
- Discard without a note, or with a note containing HTML
- Escalation stream unreachable while the page is open

## Build guidance

Build on src/dlqTriage.ts's escalation stream; reuse RedisStreamQueue.enqueue for resubmission so idempotency keys carry over. Role check in performAction.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-107, Resubmit or discard failed jobs.

As an engineer, I want to see the failed jobs that need a person and resubmit or discard them, so that nothing sits in the escalation stream forgotten.

Before writing any code, confirm STORY-102 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given escalated failed jobs, When I open the failed jobs page, Then I see each one's failure reason, class and how long it has waited
- Given I resubmit one, When I confirm, Then it is enqueued again with its original idempotency key and leaves the list
- Given I discard one, When I confirm with a required note, Then it is recorded as discarded and leaves the list
- Trust: only engineers can resubmit or discard (analysts see the page read-only), and every action is audited

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Resubmitting a job whose original actually succeeded (idempotency key must stop a duplicate)
- Discard without a note, or with a note containing HTML
- Escalation stream unreachable while the page is open

Build on src/dlqTriage.ts's escalation stream; reuse RedisStreamQueue.enqueue for resubmission so idempotency keys carry over. Role check in performAction.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-107 named in a trailer, e.g. `Story: STORY-107`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
