# Relay Analyst Console: Requirements

Console requirements are numbered REQ-101 onward so they never collide with the Colaberry platform plan's REQ-001 to REQ-018 (`docs/REQUIREMENTS.md`). Every `must` requirement is fulfilled by at least one story.

| ID | Kind | Cluster | Priority | Requirement | Fulfilled by |
|---|---|---|---|---|---|
| REQ-101 | SAFE | Access Control | must | Every console page and action must require an authenticated session, and logging in must require both the operator's password and a current authenticator (TOTP) code. | STORY-101 |
| REQ-102 | SAFE | Access Control | must | Failed logins must be rate-limited per IP and per account, sessions must expire after 8 hours of inactivity, and session cookies must be HttpOnly, Secure and SameSite=Strict. | STORY-101 |
| REQ-103 | SAFE | Audit | must | Every console action (login, logout, batch submit, review decision, resubmit, discard) must be appended to a durable audit log with operator, time, action, target and correlation ID before the action is reported as done. | STORY-102 |
| REQ-104 | SAFE | Request Integrity | must | Every state-changing console request must carry a valid per-session CSRF token from the same origin, and be rejected with 403 otherwise. | STORY-102 |
| REQ-105 | SAFE | Request Integrity | must | Every console action must be idempotent: a double-click, a retried request or the same action from two tabs must never apply it twice. | STORY-102, STORY-104 |
| REQ-106 | FUNC | Batch Intake | must | An analyst must be able to upload a CSV (at most 5,000 rows and 2 MB, one required text column), see row-level validation errors before anything is enqueued, and submit the valid rows as one batch. | STORY-104 |
| REQ-107 | FUNC | Batch Intake | must | For each batch the console must show how many items are done, waiting, waiting for review and failed, refresh without a page reload, and offer the results as a CSV download. | STORY-105 |
| REQ-108 | FUNC | Human Review | must | The console must list items waiting for review with the reason, the input text and the model's answer and confidence, and let a reviewer approve it, correct it to another label from the fixed taxonomy, or reject it. | STORY-106 |
| REQ-109 | FUNC | Human Review | must | A review decision must resolve the item exactly once: it leaves the review queue, its batch result is updated, and the decision is in the audit log. | STORY-106 |
| REQ-110 | FUNC | Failure Handling | must | The console must list escalated failed jobs with their failure reason and class, and let an engineer resubmit one with its original idempotency key or discard it with a required note. | STORY-107 |
| REQ-111 | FUNC | Monitoring | must | One overview screen must combine the plain-language status with success rate, p95 latency, queue depth and failed-job trends over the last 24 hours. | STORY-108 |
| REQ-112 | NFR | Experience | should | All console screens must meet WCAG 2.1 AA, work at 360px phone width without horizontal scrolling, and support light and dark mode. | STORY-108 |
| REQ-113 | NFR | Performance | should | List screens must render in under 1 second with up to 1,000 items, using pagination. | STORY-105 |
| REQ-114 | CONSTRAINT | Platform | must | The console must run inside the existing relay-qn Fly.io app with no new paid service, and the public read-only /status page must stay available without login. | STORY-109 |
| REQ-115 | FUNC | Batch Results | must | Workers must classify each submitted item against the fixed taxonomy and record its outcome per batch, through a classifier adapter so a real model can replace the stand-in without changes elsewhere. | STORY-103 |
