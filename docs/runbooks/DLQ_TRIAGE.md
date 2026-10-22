# Dead-Letter Queue Triage Runbook

For REQ-004 / STORY-004. This is what a human does when a job lands in
Relay's dead-letter queue (DLQ) — not a description of the code, a set of
steps to actually follow.

## What lands here, and why

A job reaches the DLQ two ways:

1. `callExternalApiAndPersist()` (`src/callExternalApi.ts`) exhausts every
   retry against an external API and `withReliability` throws
   `UpstreamCallFailedError`. See `src/dlq.ts` and `src/callExternalApi.ts`.
2. A low-confidence job couldn't be written to the review queue after 3
   attempts (STORY-007). Its `failureReason` is exactly
   `review_queue_unavailable`. It was never resolved; it only needs to be
   resubmitted once Redis is healthy.

**What does NOT land here:** a circuit-open rejection (`CircuitOpenError`).
If the breaker is open, the call was never attempted at all — that's not
"retries exhausted," and the job is expected to be retried again later once
the circuit's cooldown elapses. Don't go looking for those in the DLQ; they
were never moved here.

**What every DLQ entry carries** (see `buildDlqEntry` in `src/dlq.ts`):
- `id`, `correlationId`, `idempotencyKey` — same as the original job
- `payload.originalPayload` — the original job's payload, untouched
- `payload.failureReason` — the error message from the exhausted call
- `payload.failedAt` — ISO timestamp of when it was moved here

## Automated triage (STORY-008): most entries no longer need you

`triageNextDlqEntry()` (`src/dlqTriage.ts`) applies the Step 2 table below
as code. For each entry it:

1. Classifies the `failureReason` (`src/failureClassifier.ts`): `timeout`,
   `client_error`, `upstream_error`, `review_queue_unavailable`, or
   `unclassified`.
2. Updates the shared retry policy in Redis (`relay:retry-policy`,
   `src/retryPolicy.ts`) by the codified rules: a 4xx switches that class to
   *discard* (no more retries for bad input); a timeout or 5xx doubles that
   class's base backoff, capped at 10s; unclassified changes nothing.
   Every change is logged as `retry_policy_updated` with the entry's
   correlation ID and kept in the policy's own `history` (last 50 changes).
3. Acts on the entry under the updated policy: **resubmit** it to the work
   queue (same idempotency key, so a duplicate is safe), **discard** it
   (logged as `dlq_entry_discarded`), or **escalate** it to the escalation
   stream (logged as `dlq_entry_escalated`).

New external calls made with `retryPolicy` passed to `withReliability` then
follow the updated policy straight away.

**What you still handle by hand:** only the escalation stream. Entries land
there when the failure is `unclassified`, or when the same job has already
been resubmitted twice and failed again (`why: "resubmit_limit_reached"`).
Use Steps 2 and 3 below for those. If you find yourself making the same call
on the same kind of entry more than once, that's a rule to add to
`failureClassifier.ts` / `deriveRuleUpdate`, not a habit to keep.

**To check or reset the policy:** `redis-cli GET relay:retry-policy` shows
the current rules, version and history. Deleting the key reverts every
process to `INITIAL_POLICY` (retry everything 3 times) on its next read.

## Step 1 — check whether there's anything to triage

```bash
cd relay
docker compose up -d redis   # if it isn't already running
```

There's no CLI script yet (this is a walking skeleton — STORY-004 built the
mechanism, not an operator tool on top of it). Until one exists, triage from
a Node REPL or a short script using the real functions directly:

```ts
import { Redis } from "ioredis";
import { RedisStreamQueue } from "./src/queue.js";
import { triageNextDeadLetterEntry } from "./src/dlq.js";

const redis = new Redis();
const dlq = new RedisStreamQueue(redis, "relay:jobs:dlq", "relay-dlq-triage");
await dlq.ensureConsumerGroup();

const entry = await triageNextDeadLetterEntry(dlq, "human-triage");
console.log(entry); // { jobId, failureReason } — or null if empty
```

Calling `triageNextDeadLetterEntry` already logs a structured `job_triaged`
line with the job's correlation ID and failure reason (REQ-004's trust
criterion) — that log line is itself part of the triage record. Nothing
about triaging silently happens; it's always logged before you decide what
to do next.

## Step 2 — decide what to do, by failure reason

| `failureReason` looks like | Likely cause | What to do |
|---|---|---|
| Contains `"timed out"` / references `UpstreamTimeoutError` | The external API was slow or unresponsive for every attempt | Check whether the upstream is currently healthy. If yes, the job can likely be resubmitted safely — re-enqueue it via `queue.ts`'s `enqueue()` using the same `idempotencyKey` so a duplicate resubmission is still safe (REQ-002). If no, hold it; don't resubmit into a known-down dependency. |
| References a 4xx-style message (bad request, invalid input, unauthorized) | The job's input was wrong, not the upstream | Do **not** blindly resubmit — it will fail the same way every time. Fix the input at the source (check what produced this job) or discard it as unrecoverable, and say so explicitly when you close it out. |
| References a 5xx-style message (upstream error) | Genuine upstream instability | Resubmit is reasonable once the upstream's own status is confirmed healthy. If the same job keeps landing back in the DLQ after resubmission, stop — that's a signal something about this specific job is broken, not the upstream. |
| Anything unfamiliar | Unclassified | Don't guess. Log what you found and escalate (Step 3) rather than resubmitting blind. |

This table is deliberately small — it will grow as real failure reasons are
actually observed in this DLQ. Don't extend it with hypothetical failure
modes that haven't happened yet; extend it when a real one does, per
CLAUDE.md's "the plan holds what was planned" principle applied to
operational docs too.

## Step 3 — escalate if you're not sure

If a failure reason doesn't match anything in the table above, or matching
it still doesn't tell you what to do: stop, don't resubmit, and flag it for
review rather than guessing. A wrong guess here can double-submit external
side effects (REQ-002 protects against double-*processing* inside Relay, not
against a human manually re-triggering the same real-world action twice).

## What this runbook does not cover yet

- **Nothing runs triage on a schedule yet.** `triageNextDlqEntry()` is
  called by code (tests, demo, a script); no standing triage worker loops
  over the DLQ by itself.
- **The worker loop doesn't make external calls yet**, so policy-driven
  retries apply wherever `callExternalApiAndPersist` is called with a
  `retryPolicy`, not inside STORY-006's workers.
- **No DLQ size/age alerting.** Nothing currently pages anyone when the DLQ
  grows or an entry sits untriaged for a long time. That's observability
  work not yet built (see REQ-006/REQ-014, STORY-005/STORY-010).
- **No web UI.** Triage today means running code directly, per Step 1. A
  DLQ view is exactly the kind of thing the Command Center's future tabs
  could show, but nothing renders it yet.

Keep this list honest as gaps close — delete an item here the same day the
capability it names actually ships, not before.
