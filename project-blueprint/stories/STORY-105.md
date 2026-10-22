# STORY-105: Follow a batch's progress and download its results

**Release:** r1, Batches In, Results Out
**Fulfills:** REQ-107, REQ-113
**Blocked by:** STORY-103, STORY-104
**Primary user:** Analyst

## Story

As an analyst, I want to see how my batch is doing and download the results, so that I can hand them on without asking anyone.

## Acceptance criteria

- Given a submitted batch, When I open it, Then I see done, waiting, waiting for review and failed counts that refresh without reloading the page
- Given a finished batch, When I download results, Then I get a CSV with one row per item: input, label, confidence, status and taxonomy version
- Given a list of more than 1,000 batches or items, When I open it, Then it renders in under a second with pagination
- Trust: the counts always equal the per-item statuses (no item counted twice or missing), and downloads are audited

## Known failure paths to handle

- Results CSV opened in Excel executes a formula from an input cell
- Batch page polled by many tabs overloads Redis (polling interval and cache)
- A batch id from another operator's URL (any logged-in operator may view, but the access is audited)

## Build guidance

Batch list and detail pages under /console/batches, progress via a small JSON endpoint polled every few seconds. CSV export streams rows and prefixes formula-leading cells with an apostrophe.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-105, Follow a batch's progress and download its results.

As an analyst, I want to see how my batch is doing and download the results, so that I can hand them on without asking anyone.

Before writing any code, confirm STORY-103, STORY-104 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given a submitted batch, When I open it, Then I see done, waiting, waiting for review and failed counts that refresh without reloading the page
- Given a finished batch, When I download results, Then I get a CSV with one row per item: input, label, confidence, status and taxonomy version
- Given a list of more than 1,000 batches or items, When I open it, Then it renders in under a second with pagination
- Trust: the counts always equal the per-item statuses (no item counted twice or missing), and downloads are audited

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Results CSV opened in Excel executes a formula from an input cell
- Batch page polled by many tabs overloads Redis (polling interval and cache)
- A batch id from another operator's URL (any logged-in operator may view, but the access is audited)

Batch list and detail pages under /console/batches, progress via a small JSON endpoint polled every few seconds. CSV export streams rows and prefixes formula-leading cells with an apostrophe.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-105 named in a trailer, e.g. `Story: STORY-105`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
