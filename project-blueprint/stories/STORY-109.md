# STORY-109: Ship the console to production and verify it end to end

**Release:** r3, One Screen, Production Ready
**Fulfills:** REQ-114
**Blocked by:** STORY-104, STORY-105, STORY-106, STORY-107, STORY-108
**Primary user:** Engineer

## Story

As an engineer, I want the console live on relay-qn with real operator accounts, so that analysts can use it without me.

## Acceptance criteria

- Given a deploy, When deploy.sh runs, Then tests gate it, the smoke check covers the console login page and the public status, and a failure rolls back
- Given a real operator account created over fly ssh, When they log in from a phone authenticator, Then they can submit a batch, follow it and download results on the live site
- Given the console is live, When an unauthenticated request hits any /console route, Then it is refused
- Trust: no new paid service, no secrets in the repo, and operator TOTP secrets never appear in logs or command history

## Known failure paths to handle

- Cookie Secure flag breaks login over Fly's HTTPS termination (check the forwarded protocol)
- Admin script prints a TOTP secret into shell history
- Deploy during an in-progress batch loses no items (workers finish or reclaim)

## Build guidance

Extend scripts/deploy.sh's smoke check and docs/runbooks/DEPLOYMENT.md; add an operator-admin runbook (create, disable, reset MFA). Verify on the live URL with a real phone.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-109, Ship the console to production and verify it end to end.

As an engineer, I want the console live on relay-qn with real operator accounts, so that analysts can use it without me.

Before writing any code, confirm STORY-104, STORY-105, STORY-106, STORY-107, STORY-108 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given a deploy, When deploy.sh runs, Then tests gate it, the smoke check covers the console login page and the public status, and a failure rolls back
- Given a real operator account created over fly ssh, When they log in from a phone authenticator, Then they can submit a batch, follow it and download results on the live site
- Given the console is live, When an unauthenticated request hits any /console route, Then it is refused
- Trust: no new paid service, no secrets in the repo, and operator TOTP secrets never appear in logs or command history

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Cookie Secure flag breaks login over Fly's HTTPS termination (check the forwarded protocol)
- Admin script prints a TOTP secret into shell history
- Deploy during an in-progress batch loses no items (workers finish or reclaim)

Extend scripts/deploy.sh's smoke check and docs/runbooks/DEPLOYMENT.md; add an operator-admin runbook (create, disable, reset MFA). Verify on the live URL with a real phone.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-109 named in a trailer, e.g. `Story: STORY-109`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
