# STORY-108: See Relay's health on one overview screen

**Release:** r3, One Screen, Production Ready
**Fulfills:** REQ-111, REQ-112
**Blocked by:** STORY-101
**Primary user:** Analyst

## Story

As an analyst, I want one screen that tells me in plain words whether Relay is healthy and how it has trended today, so that I don't need two dashboards and an engineer to read them.

## Acceptance criteria

- Given monitoring data, When I open the overview, Then I see the plain-language status plus 24-hour charts of success rate, p95 latency, queue depth and failed jobs
- Given monitoring is unavailable or stale, When I open the overview, Then it says so instead of showing old numbers as current
- Given a 360px-wide phone in dark mode, When I open any console screen, Then it is readable, has no horizontal scroll, and passes WCAG 2.1 AA contrast and keyboard checks
- Trust: the public /status page stays available without login and shows no job content

## Known failure paths to handle

- Charts with gaps after a restart or deploy (show the gap, never interpolate invented data)
- Colour-only status indicators unreadable for colour-blind users
- History endpoint slow with a week of samples

## Build guidance

Combine statusView.ts and the SLO dashboard into /console (home), charts as inline SVG from /metrics/history (no chart library), design tokens for light/dark. Run an accessibility pass (axe or the fixing-accessibility skill) over every console page.

---

## Build prompt

Copy everything below this line into Claude Code to build this story.

```
Context: Relay is at relay/ (TypeScript, Redis Streams, deployed on Fly.io as relay-qn). Read relay/project-blueprint/architecture.md and relay/project-blueprint/HOW_WE_BUILD.md before starting.

Implement STORY-108, See Relay's health on one overview screen.

As an analyst, I want one screen that tells me in plain words whether Relay is healthy and how it has trended today, so that I don't need two dashboards and an engineer to read them.

Before writing any code, confirm STORY-101 is already built and
working. If it isn't, stop and say so rather than building on top of
something that doesn't exist yet.

Build only what this story needs, don't build ahead into another story's
scope, even if it looks convenient to do now.

Acceptance criteria, all of these must genuinely pass, not just the
happy-path ones:
- Given monitoring data, When I open the overview, Then I see the plain-language status plus 24-hour charts of success rate, p95 latency, queue depth and failed jobs
- Given monitoring is unavailable or stale, When I open the overview, Then it says so instead of showing old numbers as current
- Given a 360px-wide phone in dark mode, When I open any console screen, Then it is readable, has no horizontal scroll, and passes WCAG 2.1 AA contrast and keyboard checks
- Trust: the public /status page stays available without login and shows no job content

Handle these failure paths explicitly; none of them should surface as an
unhandled exception or a silent no-op:
- Charts with gaps after a restart or deploy (show the gap, never interpolate invented data)
- Colour-only status indicators unreadable for colour-blind users
- History endpoint slow with a week of samples

Combine statusView.ts and the SLO dashboard into /console (home), charts as inline SVG from /metrics/history (no chart library), design tokens for light/dark. Run an accessibility pass (axe or the fixing-accessibility skill) over every console page.

When you believe the story is done:
1. Write or update tests covering the happy path and at least one failure
   path from the list above.
2. Re-check every acceptance criterion against what the code actually
   does, don't mark one done because it was intended to work.
3. No secrets in code, commits, or logs. Every side effect must be
   idempotent, running it twice must not double anything.
4. Commit with STORY-108 named in a trailer, e.g. `Story: STORY-108`.
5. If this project has a PROGRESS.md convention or a CLAUDE.md build
   contract, follow it before calling the story done.
```
