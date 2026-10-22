# STORY-101: Log in to the console with a password and an authenticator code

**Release:** r0, Safe Front Door
**Fulfills:** REQ-101, REQ-102
**Blocked by:** none
**Primary user:** Analyst

## Story

As an analyst, I want to log in with my password and an authenticator code, so that nobody else can act on Relay in my name.

## Acceptance criteria

- Given a valid password and current TOTP code, When I log in, Then I get a session and reach the protected console home page
- Given a wrong password or code, When I log in, Then I am refused with one generic message that doesn't say which part was wrong
- Given 5 failed attempts for an account or IP within 15 minutes, When I try again, Then I am refused until the window passes, even with correct credentials
- Trust: no console page or action responds without a valid session (401 for API calls, redirect to login for pages), checked against every /console route

## Known failure paths to handle

- A TOTP code from the previous or next 30-second step is rejected because of phone clock drift (allow exactly +/-1 step, never more)
- Session store (Redis) unreachable at login: must refuse to log in, never fall back to an unchecked session
- Timing difference between unknown user and wrong password leaks which accounts exist

## Build guidance

Port CoreOps's hand-rolled auth (ai-operations-center/mcp-server/src/auth/totp.ts and its scrypt credentials helper) into relay/src/console/auth/, node:crypto only. Operator accounts (username, role analyst|engineer, scrypt hash, TOTP secret) live in Redis, created by an admin script run over `fly ssh console`; sessions in Redis with an 8-hour idle TTL; cookies HttpOnly, Secure, SameSite=Strict. Add /console routes to the existing status server; leave /status, /status.json and /health public.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-101, Log in to the console with a password and an authenticator code.

As an analyst, I want to log in with my password and an authenticator code, so that nobody else can act on Relay in my name.

This story has no prerequisite stories. The existing Relay system (relay/, deployed at relay-qn.fly.dev) is the base;
read relay/project-blueprint/architecture.md first.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given a valid password and current TOTP code, When I log in, Then I get a session and reach the protected console home page
- Given a wrong password or code, When I log in, Then I am refused with one generic message that doesn't say which part was wrong
- Given 5 failed attempts for an account or IP within 15 minutes, When I try again, Then I am refused until the window passes, even with correct credentials
- Trust: no console page or action responds without a valid session (401 for API calls, redirect to login for pages), checked against every /console route

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- A TOTP code from the previous or next 30-second step is rejected because of phone clock drift (allow exactly +/-1 step, never more)
- Session store (Redis) unreachable at login: must refuse to log in, never fall back to an unchecked session
- Timing difference between unknown user and wrong password leaks which accounts exist

Port CoreOps's hand-rolled auth (ai-operations-center/mcp-server/src/auth/totp.ts and its scrypt credentials helper) into relay/src/console/auth/, node:crypto only. Operator accounts (username, role analyst|engineer, scrypt hash, TOTP secret) live in Redis, created by an admin script run over `fly ssh console`; sessions in Redis with an 8-hour idle TTL; cookies HttpOnly, Secure, SameSite=Strict. Add /console routes to the existing status server; leave /status, /status.json and /health public.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-101 named in a trailer, e.g. `Story: STORY-101`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
