# STORY-104: Submit a batch by uploading a CSV

**Release:** r1, Batches In, Results Out
**Fulfills:** REQ-106, REQ-105
**Blocked by:** STORY-102, STORY-103
**Primary user:** Analyst

## Story

As an analyst, I want to upload a CSV of companies and submit it as one batch, so that I don't need an engineer to start a run.

## Acceptance criteria

- Given a valid CSV with a text column, When I upload it, Then I see a preview with the row count and can submit it as one batch
- Given rows that are empty, too long, or a file over 5,000 rows or 2 MB, When I upload it, Then I see which rows are wrong and why, and nothing is enqueued until I confirm the valid rows
- Given I press submit twice or refresh, When the batch is submitted, Then it is enqueued exactly once
- Trust: the submission is audited with the batch id, row count and operator, and every enqueued job carries the batch id and its own correlation ID

## Known failure paths to handle

- CSV with formula-injection cells (=, +, -, @) that later open in Excel
- Upload with a non-UTF-8 encoding or a BOM
- Redis fills up mid-enqueue (noeviction): partial batch must be reported, not hidden

## Build guidance

Parse CSV in relay/src/console/csv.ts without a new dependency (quoted fields, BOM, CRLF), validate, store the batch record, then enqueue through the existing RedisStreamQueue inside performAction. Neutralise formula-leading cells on output (STORY-105), never execute them.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-104, Submit a batch by uploading a CSV.

As an analyst, I want to upload a CSV of companies and submit it as one batch, so that I don't need an engineer to start a run.

Before writing any code, confirm STORY-102, STORY-103 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given a valid CSV with a text column, When I upload it, Then I see a preview with the row count and can submit it as one batch
- Given rows that are empty, too long, or a file over 5,000 rows or 2 MB, When I upload it, Then I see which rows are wrong and why, and nothing is enqueued until I confirm the valid rows
- Given I press submit twice or refresh, When the batch is submitted, Then it is enqueued exactly once
- Trust: the submission is audited with the batch id, row count and operator, and every enqueued job carries the batch id and its own correlation ID

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- CSV with formula-injection cells (=, +, -, @) that later open in Excel
- Upload with a non-UTF-8 encoding or a BOM
- Redis fills up mid-enqueue (noeviction): partial batch must be reported, not hidden

Parse CSV in relay/src/console/csv.ts without a new dependency (quoted fields, BOM, CRLF), validate, store the batch record, then enqueue through the existing RedisStreamQueue inside performAction. Neutralise formula-leading cells on output (STORY-105), never execute them.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-104 named in a trailer, e.g. `Story: STORY-104`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
