# Relay Analyst Console: How We Build

Read this before starting any story from `project-blueprint/stories/`.

## Where the truth lives

- `project-blueprint/REQUIREMENTS.md`, what the system must do
- `project-blueprint/RELEASES.md`, the work, by release
- `project-blueprint/stories/STORY-nnn.md`, one story in full, with its
  acceptance criteria
- `project-blueprint/plan.json`, the same data, machine-readable

Read the requirement before writing code for a story. If a requirement or
acceptance criterion turns out to be wrong once you're actually building
against it, fix the requirement, you're the architect here, not a typist.

## How we build

- **Walking skeleton first.** Get the thinnest end-to-end path of Release 0
  working, including whatever trust guarantee this system promises (an
  approval gate, an audit trail, a permission boundary), before stacking
  feature work on top of it.
- **Small, reversible steps.** A change you can't undo in one command is
  too big.
- **Every external call gets an explicit timeout and capped retries.** No
  unbounded waits.
- **Every side effect is idempotent.** Running it twice must not
  double-charge, double-send, or double-create anything. If a retry can
  produce a duplicate, it's broken.
- **Never swallow an error.** An empty `catch` block is a defect, not
  tidiness.

## Definition of done

A story is done when **every** acceptance criterion on it passes **and** a
commit names it. Both halves, all of the criteria, not just the important
ones, and the work actually in git, not just checked off in your head.

1. Tests cover the happy path **and** at least one failure path from the
   story's "Known failure paths to handle" list.
2. No secrets in code, commits, or logs.
3. Every acceptance criterion in the story file genuinely passes, re-check
   against what the code actually does, not what you intended it to do.

## When you finish a story

1. **Record the story's status honestly.** If this project has a
   PROGRESS.md convention, add an entry there naming the story and which
   criteria pass. If it tracks status in `project-blueprint/plan.json`
   instead, update that story's entry the same way. A partly-finished
   story is a real, expected state, report it as such, don't round up.
2. **Commit**, naming the story in a trailer: `Story: STORY-101`
   on its own line below the commit message. The commit must change at
   least one real file.

## What not to invent

Don't add acceptance criteria beyond what the story file defines, and
don't mark a criterion as passing because it's *supposed* to work, only
because you verified that it does.

## Relay-specific

- Relay's own `relay/CLAUDE.md` and `relay/PROGRESS.md` conventions still apply (session ID on every PROGRESS entry, `.colaberry/` files are the platform's).
- Console stories are outside the Colaberry platform plan: don't add them to `.colaberry/plan.json` or `progress.json`.
- Every story ends with real verification: tests against real Redis, plus the page exercised in a browser, not only unit tests.
