# Relay — Requirement Acceptance Checks

One line per requirement in [`REQUIREMENTS.md`](REQUIREMENTS.md): a check
verifiable from repo state — a grep pattern, a file, a passing test, or a
live URL — not a description of intended behavior. Update the checkbox only
when the check genuinely passes; see `CLAUDE.md`'s definition of done.

- [ ] **REQ-001** (queue tech) — `grep -rl "ioredis\|@aws-sdk/client-sqs" --include=*.ts . | grep -v test` returns a non-test source file.
- [ ] **REQ-002** (idempotency) — a test calls the job handler twice with the same idempotency key and asserts the second call produces zero additional side effects.
- [ ] **REQ-003** (circuit breaker) — `grep -rl "circuitBreaker\|CircuitBreaker" --include=*.ts .` finds a module, and its test suite asserts calls are blocked while the breaker is open.
- [ ] **REQ-004** (DLQ + runbook) — `find . -iname "*dlq*"` returns both a code artifact and a markdown triage runbook (not just one or the other).
- [ ] **REQ-005** (structured logs + correlation ID) — a sample emitted log line parses as valid JSON and contains `correlation_id`, with that field traced across at least 3 distinct call sites (queue, worker, external call).
- [ ] **REQ-006** (SLO dashboard) — hitting the dashboard route/URL returns real success-rate and p95-latency figures, not placeholder text.
- [ ] **REQ-007** (autoscaling workers) — deploy config (`fly.toml`/`docker-compose.yml`/equivalent) specifies more than one worker instance/replica.
- [ ] **REQ-008** (chaos drill) — a dated markdown doc under `docs/` describes a specific drill actually run (what was killed, what broke, what was hardened), not a template.
- [ ] **REQ-009** (production deploy) — `curl <deployed-url>/health` (or equivalent), a non-localhost URL recorded in `README.md`, returns 200.
- [ ] **REQ-010** (low-confidence → review queue) — a test asserts a below-threshold classification lands in `needs_review` state, never `dead_letter`.
- [ ] **REQ-011** (log low-confidence w/ correlation ID) — a `needs_review` log line includes `correlation_id`, verified by test or log-format check.
- [ ] **REQ-012** (schema validation before persist) — `guardrails/outputContractGuardrail.ts` tests pass (`npx vitest run`) **and** `grep -rl "checkOutputContractGuardrail" --include=*.ts . | grep -v guardrails/` shows a caller outside the guardrails module (currently: tests pass, no caller yet).
- [ ] **REQ-013** (plain-language status view) — the analyst-facing UI renders job counts as plain sentences (e.g. "187 items need review"), with no raw error class or stack trace visible in that view's source.
- [ ] **REQ-014** (tracked metrics) — the monitoring module names all 5 metrics (`success_rate`, `p95`, `dlq_rate`, `circuit_breaker_trip`, `queue_depth`) as distinct fields — `grep -c` across the 5 patterns returns 5.
- [ ] **REQ-015** (failure modes → retry policy) — the retry-policy source references specific named error classes (`RateLimitError`, `AuthError`, `UpstreamUnavailable`, etc.), each mapped to a distinct retry behavior, not one generic catch-all.
- [ ] **REQ-016** (grounded summaries) — `guardrails/groundingGuardrail.ts` tests pass **and** `grep -rl "checkGroundingGuardrail" --include=*.ts . | grep -v guardrails/` shows a caller outside the guardrails module (currently: tests pass, no caller yet).
- [ ] **REQ-017** (fixed taxonomy) — a taxonomy enum/const exists and the classifier function's return type is constrained to it, not a free-text string — `grep -rl "CLASSIFICATION_TAXONOMY" --include=*.ts .` plus a type-level check.
- [ ] **REQ-018** (SLO dashboard as ongoing check) — same artifact as REQ-006, referenced by name in the REQ-008 chaos-drill doc as what was actually watched during the drill.
