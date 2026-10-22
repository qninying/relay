# STORY-102: Record every console action and make it impossible to forge or repeat

**Release:** r0, Safe Front Door
**Fulfills:** REQ-103, REQ-104, REQ-105
**Blocked by:** STORY-101
**Primary user:** Engineer

## Story

As an engineer, I want every console action recorded and protected against forgery and double-submission, so that I can always say who did what and nothing happens twice.

## Acceptance criteria

- Given a logged-in operator, When they perform any action, Then an audit entry with operator, time, action, target, outcome and correlation ID is written before the response says it succeeded
- Given a state-changing request without a valid CSRF token or from another origin, When it arrives, Then it is rejected with 403 and the rejection is audited
- Given the same action submitted twice with the same idempotency key, When the second arrives, Then it returns the first result and changes nothing
- Trust: if the audit log can't be written, the action is not performed and the operator is told it failed

## Known failure paths to handle

- Audit write fails after the action already happened (must be impossible: audit first or both in one transaction)
- Two tabs submit the same action at the same moment (race on the idempotency check)
- Audit log grows without bound in Redis

## Build guidance

One `performAction(operator, action, idempotencyKey, fn)` wrapper in relay/src/console/actions.ts that every later story uses: checks CSRF + origin, claims the idempotency key with SET NX (same pattern as RedisIdempotencyStore), writes the audit entry to a capped Redis stream (e.g. 90 days), then runs fn. A read-only /console/audit page lists recent entries.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-102, Record every console action and make it impossible to forge or repeat.

As an engineer, I want every console action recorded and protected against forgery and double-submission, so that I can always say who did what and nothing happens twice.

Before writing any code, confirm STORY-101 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given a logged-in operator, When they perform any action, Then an audit entry with operator, time, action, target, outcome and correlation ID is written before the response says it succeeded
- Given a state-changing request without a valid CSRF token or from another origin, When it arrives, Then it is rejected with 403 and the rejection is audited
- Given the same action submitted twice with the same idempotency key, When the second arrives, Then it returns the first result and changes nothing
- Trust: if the audit log can't be written, the action is not performed and the operator is told it failed

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Audit write fails after the action already happened (must be impossible: audit first or both in one transaction)
- Two tabs submit the same action at the same moment (race on the idempotency check)
- Audit log grows without bound in Redis

One `performAction(operator, action, idempotencyKey, fn)` wrapper in relay/src/console/actions.ts that every later story uses: checks CSRF + origin, claims the idempotency key with SET NX (same pattern as RedisIdempotencyStore), writes the audit entry to a capped Redis stream (e.g. 90 days), then runs fn. A read-only /console/audit page lists recent entries.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-102 named in a trailer, e.g. `Story: STORY-102`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
