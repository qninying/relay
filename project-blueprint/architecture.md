# Relay Analyst Console: Architecture

Scope: the console (UI/UX) added on top of the Relay system that is already
built and deployed. Everything under "Existing system" describes code that
exists and runs today (13 of 13 platform stories, live at
https://relay-qn.fly.dev); nothing there is proposed. "Console" components
are new.

## Idea

Relay fans out large batches of research, classification and summarization
work to a pool of AI agent workers, reliably and with every item accounted
for. Today a person can only *watch* it: there is no way to submit a batch,
act on items waiting for human review, or deal with failed jobs without a
terminal. The analyst console gives RevOps and research-ops analysts and the
engineers who run Relay a secure, logged-in web UI to submit batches and
follow them, decide on items that need a human, handle failed jobs, and see
Relay's health on one screen.

**Must do well on day one:** nobody can act on Relay without logging in with
a password and an authenticator code, and every action they take is recorded
and can't be applied twice.

## Users

- **Analyst** (RevOps / research ops): submits batches, follows progress,
  downloads results, reviews low-confidence items.
- **Engineer** (operates Relay): everything an analyst can do, plus failed
  jobs (resubmit / discard).

## Existing system (built, deployed)

| Component | Where | Role for the console |
|---|---|---|
| Job queue (Redis Streams, consumer group) | `src/queue.ts` | Batch items are enqueued here. |
| Autoscaled worker processes | `src/server.ts`, `src/processWorkerPool.ts`, `src/autoscaler.ts`, `src/workerLoop.ts` | Process items; ack after handling; reclaim from dead workers. |
| Shared idempotency store | `src/idempotencyStore.ts` | Exactly-once processing; console actions reuse the pattern. |
| Review queue (low confidence, ungrounded summaries) | `src/reviewQueue.ts`, `src/jobRouter.ts` | Source for the review screen. |
| DLQ + automated triage + escalation stream | `src/dlq.ts`, `src/dlqTriage.ts` | Source for the failed-jobs screen (escalated items). |
| Fixed taxonomy + `classifyJob` | `taxonomies/industry.v1.json`, `src/classifyJob.ts` | Labels a reviewer may choose; classification is a library function, **not yet called by workers**. |
| Monitoring sampler + history | `src/monitoringSampler.ts` | Data for the overview screen. |
| Plain-language status + SLO dashboard | `src/statusView.ts`, `src/statusServer.ts`, `src/dashboard.html` | Merged into the overview; public `/status` stays. |
| Structured logging with correlation IDs | `src/logger.ts` | Console actions log the same way. |

## Console components (new)

| Component | Responsibility |
|---|---|
| Auth (password + TOTP) | scrypt password hashes and RFC 6238 TOTP with `node:crypto` only, ported from CoreOps (`mcp-server/src/auth/totp.ts`, `credentials.ts`); login rate limiting; server-side sessions in Redis. |
| Request integrity | CSRF token per session, same-origin check, idempotency key per action. |
| Audit log | Append-only Redis stream of every console action (operator, action, target, correlation ID, outcome). |
| Batch registry + results store | Batch metadata and per-item outcome/result in Redis, written by workers. |
| Worker classification step | Workers call `classifyJob` through a classifier adapter (stand-in or real model). |
| Console pages | Server-rendered HTML + small vanilla JS from the existing status server; no SPA build step. |

## How it fits together

Browser -> `relay-qn` status server (new `/console/*` routes, session-checked)
-> Redis (sessions, audit, batches, queues) <- workers (results per batch).
The public read-only routes (`/status`, `/status.json`, `/health`) are
unchanged and need no login.

## Build order

1. Login and the action-safety layer (audit, CSRF, idempotency), proven on a
   read-only page.
2. Make workers produce real per-item results, then batch submit and progress.
3. The human loops: review decisions, failed-job actions.
4. The overview screen, accessibility pass, production rollout.

## Decisions (2026-10-22)

1. **Classifier behind the workers: stand-in now, Claude later.** STORY-103
   builds a classifier adapter and ships the free keyword stand-in behind
   it, so the console works end to end with demo-quality results. A real
   Claude adapter is a separate, later decision (API key as a Fly secret,
   per-item cost). Decided by Quincy.
2. **Page technology: server-rendered HTML + small vanilla JS.** Same
   approach as the existing status page: no new dependencies, no build
   step, same-origin forms. Decided by Quincy.
3. **Accounts: named operator accounts with a role (analyst / engineer),**
   created by an admin script. Assumed rather than asked, because the audit
   log needs to say who did what; one shared account would defeat it.

## Not covered

Self-service sign-up, password reset by email, SSO, multi-tenant
separation, real summarization in workers (needs a source fetcher and a
summarizer model; the review screen handles ungrounded summaries if and
when they arrive).
