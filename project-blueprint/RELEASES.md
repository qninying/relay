# Relay Analyst Console: Releases

Stories are numbered STORY-101 onward, separate from the platform plan's STORY-000 to STORY-012. Weeks are relative to the start of console work.

## r0: Safe Front Door (weeks 0-1)

**Goal:** Prove nobody can act on Relay without password + authenticator login, and that every action is recorded and can't be applied twice.

**Demo:** Log in with a password and a phone authenticator code, see a protected page, get locked out after repeated bad codes, and show the audit log recording every attempt.

- **STORY-101: Log in to the console with a password and an authenticator code**. As an analyst, I want to log in with my password and an authenticator code, so that nobody else can act on Relay in my name.
- **STORY-102: Record every console action and make it impossible to forge or repeat**. As an engineer, I want every console action recorded and protected against forgery and double-submission, so that I can always say who did what and nothing happens twice.

## r1: Batches In, Results Out (weeks 1-2)

**Goal:** An analyst can upload a CSV, watch the batch finish, and download real per-item results.

**Demo:** Upload a 200-row CSV with two bad rows, see the row errors, submit the rest, watch the progress bars fill, and download the classified results.

- **STORY-103: Classify each batch item in the workers and record its result**. As an analyst, I want every item I submit to come back with a real classification and status, so that a batch's results mean something.
- **STORY-104: Submit a batch by uploading a CSV**. As an analyst, I want to upload a CSV of companies and submit it as one batch, so that I don't need an engineer to start a run.
- **STORY-105: Follow a batch's progress and download its results**. As an analyst, I want to see how my batch is doing and download the results, so that I can hand them on without asking anyone.

## r2: Humans in the Loop (weeks 2-3)

**Goal:** Items that need a person can be decided in the console, exactly once.

**Demo:** Approve one low-confidence item, correct another to a different taxonomy label, reject a third, then resubmit a failed job and discard another with a note, all visible in the audit log.

- **STORY-106: Decide on items waiting for review**. As a reviewer, I want to approve, correct or reject items the model wasn't sure about, so that low-confidence answers never reach results unchecked.
- **STORY-107: Resubmit or discard failed jobs**. As an engineer, I want to see the failed jobs that need a person and resubmit or discard them, so that nothing sits in the escalation stream forgotten.

## r3: One Screen, Production Ready (weeks 3-4)

**Goal:** Relay's health on one accessible screen, and the whole console live in production.

**Demo:** Open the overview on a phone in dark mode, read the 24-hour trends, then log in to the live console at relay-qn.fly.dev and submit a batch end to end.

- **STORY-108: See Relay's health on one overview screen**. As an analyst, I want one screen that tells me in plain words whether Relay is healthy and how it has trended today, so that I don't need two dashboards and an engineer to read them.
- **STORY-109: Ship the console to production and verify it end to end**. As an engineer, I want the console live on relay-qn with real operator accounts, so that analysts can use it without me.
