# STORY-106: Decide on items waiting for review

**Release:** r2, Humans in the Loop
**Fulfills:** REQ-108, REQ-109
**Blocked by:** STORY-103
**Primary user:** Analyst

## Story

As a reviewer, I want to approve, correct or reject items the model wasn't sure about, so that low-confidence answers never reach results unchecked.

## Acceptance criteria

- Given an item waiting for review, When I open it, Then I see the reason, the input text, the model's label and confidence, and the taxonomy's labels to choose from
- Given I approve or correct it, When I submit, Then the item's batch result is updated with my label, it leaves the queue, and it counts as done
- Given I reject it, When I submit, Then it is recorded as rejected with my note and leaves the queue
- Trust: a decision is applied exactly once even if two reviewers act on the same item at the same moment, and only labels from the fixed taxonomy are accepted

## Known failure paths to handle

- Two reviewers decide the same item simultaneously
- Taxonomy changed since the item was classified (show and record the version used)
- Review stream entry consumed but the result update fails (no item lost or left half-decided)

## Build guidance

Read the review stream with peek for the list; apply decisions through performAction with the item's idempotency key, updating the batch result and acking/removing the review entry in one step. Validate corrections against the loaded taxonomy codes.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-106, Decide on items waiting for review.

As a reviewer, I want to approve, correct or reject items the model wasn't sure about, so that low-confidence answers never reach results unchecked.

Before writing any code, confirm STORY-103 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given an item waiting for review, When I open it, Then I see the reason, the input text, the model's label and confidence, and the taxonomy's labels to choose from
- Given I approve or correct it, When I submit, Then the item's batch result is updated with my label, it leaves the queue, and it counts as done
- Given I reject it, When I submit, Then it is recorded as rejected with my note and leaves the queue
- Trust: a decision is applied exactly once even if two reviewers act on the same item at the same moment, and only labels from the fixed taxonomy are accepted

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Two reviewers decide the same item simultaneously
- Taxonomy changed since the item was classified (show and record the version used)
- Review stream entry consumed but the result update fails (no item lost or left half-decided)

Read the review stream with peek for the list; apply decisions through performAction with the item's idempotency key, updating the batch result and acking/removing the review entry in one step. Validate corrections against the loaded taxonomy codes.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-106 named in a trailer, e.g. `Story: STORY-106`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
