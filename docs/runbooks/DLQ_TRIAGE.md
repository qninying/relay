# Dead-Letter Queue Triage Runbook

For REQ-004 / STORY-004. This is what a human does when a job lands in
Relay's dead-letter queue (DLQ) — not a description of the code, a set of
steps to actually follow.

## What lands here, and why

A job reaches the DLQ only one way right now: `callExternalApiAndPersist()`
(`src/callExternalApi.ts`) exhausts every retry against an external API and
`withReliability` throws `UpstreamCallFailedError`. See `src/dlq.ts` and
`src/callExternalApi.ts` for the exact code path.

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

- **No automated retry-from-DLQ.** Resubmission in Step 2 is a manual
  action right now. Codifying it — matching failure reasons to retry
  policy automatically — is REQ-015 / STORY-008's job, not this one.
- **No DLQ size/age alerting.** Nothing currently pages anyone when the DLQ
  grows or an entry sits untriaged for a long time. That's observability
  work not yet built (see REQ-006/REQ-014, STORY-005/STORY-010).
- **No web UI.** Triage today means running code directly, per Step 1. A
  DLQ view is exactly the kind of thing the Command Center's future tabs
  could show, but nothing renders it yet.

Keep this list honest as gaps close — delete an item here the same day the
capability it names actually ships, not before.
