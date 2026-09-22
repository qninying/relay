# PROGRESS.md — Relay

Tracks implementation work on Relay, session by session.

---

- [x] Initial repo scaffold
  - Date: 2026-09-21
  - Session: CC-20260921-r1ay
  - What changed: Created the Relay repository — README (project pitch), MIT LICENSE, .gitignore, and BuildIdeaPrompt.txt (design brief for the architecture/knowledge-base build phase). No implementation code yet.
  - Verification: `git log --oneline` shows the initial commit; local folder and files exist as listed.
  - Notes: Scaffold only, matching the CoreOps/AmBit repo convention. Architecture, stories, and `.colaberry/` sync files are deferred to the platform-driven build phase, not fabricated here.

- [x] Connect repo to the Colaberry platform
  - Date: 2026-09-21
  - Session: CC-20260921-r1ay
  - What changed: Placed the platform's build-docs export — `docs/REQUIREMENTS.md`, `docs/STORIES.md`, `docs/TRACEABILITY.md`, `docs/DATA_CONTRACT.md`, `docs/stories/STORY-000..012.md`, `docs/CONNECT-YOUR-REPO.md`, `CLAUDE.md` (platform conventions), and `.colaberry/{plan,progress,profile,manifest}.json` (seed files renamed to their real names, since none existed yet). Added `.colaberry/connect.txt` with the pairing ID from the portal so the platform can find this repo. No implementation code yet; no story criteria are true yet.
  - Verification: `git log --oneline` shows the connect commit pushed to `origin/main`; `.colaberry/connect.txt` present in the repo.
  - Notes: This replaces the local-only `CLAUDE.md` placeholder decision from the initial scaffold — the platform's version is now the real one for this repo, same as CoreOps/AmBit.

- [x] Add first two safety guardrails: output contract + injection tripwire, grounding enforcement
  - Date: 2026-09-21
  - Session: CC-20260921-r1ay
  - What changed: New `guardrails/` module (TypeScript, vitest, matching CoreOps's `/guardrails` pattern): `outputContractGuardrail.ts` rejects job output that's missing a required field, carries a field outside the declared schema, or contains an embedded-instruction pattern (prompt-injection tripwire) — the mechanical defense for the fact that every worker feeds untrusted external content into an LLM call. `groundingGuardrail.ts` rejects a generated summary that has low lexical overlap with its own source text or states a number absent from the source, catching likely fabrication without a second LLM call. Both are pure, deterministic, no I/O, and cover REQ-012/REQ-016's intent. Two other candidate guardrails (PII/secret redaction on persist, a runaway-cost circuit breaker on retries) were scoped but deliberately deferred until the persistence and retry-policy code they'd integrate against actually exists — building them now would mean guessing at interfaces.
  - Verification: `npx vitest run` — 16/16 tests passing (both files); `npx tsc --noEmit` — clean, no errors.
  - Notes: Not yet wired into a running pipeline (none exists yet), so no `.colaberry/progress.json` criteria are ticked — STORY-003's "output is validated against the JSON schema before persisting" criterion requires the check to run in the actual persist path, which this standalone module doesn't do yet. This is foundational guardrail code the pipeline will call once STORY-001/002/003 build the queue and workers.

- [x] Add docs/ACCEPTANCE_CHECKS.md
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: One repo-verifiable acceptance check per requirement (REQ-001..018) — a grep pattern, file existence, passing test, or live URL — instead of prose describing intended behavior. All 18 are currently unchecked; REQ-012 and REQ-016 note that their guardrail logic exists and passes tests but isn't yet called from a pipeline, so the check still fails honestly.
  - Verification: `docs/ACCEPTANCE_CHECKS.md` present in the repo with 18 checklist items, one per requirement in `docs/REQUIREMENTS.md`.
  - Notes: Not a `.colaberry/progress.json` criterion source — this is a working document for tracking real completion as stories get built, not something the platform reads.

- [x] Scaffold the MCP server over stdio (platform Core Build task, fulfils R2)
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: New `mcp-server/` module (TypeScript, `@modelcontextprotocol/sdk`, matching CoreOps's stdio-entry/factory split). `mcpServerFactory.ts` registers one read-only resource, `relay://jobs/needs-review` (fixture jobs in `needs_review` state — the third outcome distinct from success/dead-letter, per REQ-010 — with an honest `source: "fixture"` field since no real queue exists yet), and one tool stub, `submit_batch_job` (always responds `stub: true, accepted: false` rather than faking success). `index.ts` connects over stdio. Added `.mcp.json` at repo root so Claude Code registers it locally, same pattern as CoreOps's.
  - Verification: `npx tsc --noEmit` clean; ran the real server via a throwaway MCP client script over stdio — connected, `listResources`/`listTools`/`readResource`/`callTool` all returned the expected shapes (script removed after, not committed); separately verified interactively via `npx @modelcontextprotocol/inspector`, connected in the browser, resource and tool both exercised live.
  - Notes: Stub only — `submit_batch_job` does not enqueue anything yet, matching the task's own scope ("one tool stub"). Not wired to the guardrails module yet either.

- [x] STORY-000: build the Command Center
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: `index.html` (Overview) plus all 8 remaining tabs (`outcomes`, `users`, `guardrails`, `systems`, `project-management`, `agents`, `knowledge-base`, `data-model`), sharing `assets/command-center.js`/`.css` — all reading `.colaberry/plan.json`/`progress.json`/`manifest.json` at runtime via `fetch`, no hard-coded plan content. Every card/bar drills down one level (Overview's 4 summary cards, role cards, system cards, and release Gantt bars all link to a real detail view — caught these not being clickable at first and fixed it rather than ticking the criterion anyway). Knowledge Base has a working local keyword search across requirements/stories/roles/systems, each hit tagged with its source tab, honest no-match fallback. Outcomes and Guardrails show honest empty states (no measures, no SAFE-typed requirement) instead of inventing content, per the brief's own instruction to raise that gap.
  - Verification: Manually verified live in-browser (served over real HTTP, not `file://`, since `fetch` is CORS-blocked under `file://`) — all 9 tabs reachable, every drill-down clicked through, Sample vs Real mode toggled and confirmed (sample badge only in Sample mode), Data-as-of stamp present on every page, no console errors. Found and fixed a real timezone bug during review: date-only fields (`due_on`, `build_start`, etc.) rendered one day early in negative-UTC-offset zones because `toLocaleDateString` had no `timeZone` option — added `timeZone: "UTC"` to `formatDateOrUnset` and `formatDataAsOf`, re-verified dates match the source data exactly.
  - Notes: `.colaberry/progress.json` updated — all 5 STORY-000 criteria set `true` with `files_touched` and a `notes` field describing verification; `verification` block (state/commit_sha/etc.) left untouched for the platform to compute after reading this commit. GitHub Pages (Step 4, optional) not enabled — held off since it's a repo setting change, not asked for yet.

- [x] Enable GitHub Pages, fix Jekyll excluding .colaberry/
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: Enabled GitHub Pages on `main`/`/` (`gh api .../pages`, one-time repo setting, asked first). Live site immediately showed ".colaberry/plan.json is missing or unreadable" — GitHub Pages' default Jekyll processing silently excludes any dotfolder, so `.colaberry/` never got published. Added an empty `.nojekyll` at the repo root, the standard fix, which tells Pages to serve every file as-is with no Jekyll processing.
  - Verification: Before the fix, `curl https://qninying.github.io/relay/.colaberry/plan.json` returned 404 and the live Overview tab showed the missing-data empty state, confirmed by screenshot. Neither CoreOps nor AmBit has a `.nojekyll` file either, so this same bug likely affects their Pages sites too (neither demos from Pages as primary URL, which is presumably why it went uncaught).
  - Notes: Re-verify after this pushes and Pages rebuilds — `curl` the same plan.json URL and reload the live Overview tab to confirm data now loads. (Confirmed working in a later check: `plan.json` now returns 200.)

- [x] STORY-001: process a job with idempotency and logging
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: New `src/` package (TypeScript + vitest, matching `guardrails/`/`mcp-server/`). `logger.ts` — structured JSON logs with a caller-supplied correlation ID (REQ-005), defensive against its own failure (a circular `context` is caught and replaced with a fallback line instead of throwing). `idempotencyStore.ts` — `InMemoryIdempotencyStore` with an atomic `claim()` (REQ-002), swappable interface for STORY-002's real queue-backed store. `processJob.ts` — ties them together: every path (processed / skipped-duplicate / failed) logs with the job's correlation ID. Built paced, one step at a time per this story's own "how I want you to work" instruction (scaffold, then logic+tests, confirmed before each).
  - Verification: `npx vitest run` — 15/15 passing; `npx tsc --noEmit` — clean (caught and fixed one real strict-mode type error vitest's own transform didn't flag). Test names map directly to the 3 acceptance criteria plus the story's named failure paths (job fails to process, job processes twice, logging fails).
  - Notes: `.colaberry/progress.json` updated — all 3 criteria `true`, `files_touched`/`tests_added` filled. `.colaberry/enrichment/STORY-001.json` written per the story's instructions (facts, decisions, limitations, test evidence); `sourceCommitSha` left `null` since it can't be known before this commit exists. In-memory store only — no real queue yet, deliberately, since STORY-002 owns that.

- [x] STORY-002: process jobs with durable queue and logging
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: `docker-compose.yml` — real Redis 7 container for local dev (no AWS credentials available, so Redis Streams over SQS per REQ-001's either/or). `src/queue.ts` — `RedisStreamQueue` wrapping real Streams commands (`XADD`/`XGROUP`/`XREADGROUP`/`XACK`) via `ioredis`, consumer-group based so delivery is explicitly acked. `dequeueOne()` logs `job_dequeued` with the correlation ID (criterion 1) and `job_low_confidence` with the same correlation ID when `job.confidence` is below a placeholder threshold (criterion 2, REQ-011). `processJob.ts`'s `Job` type extended with optional `confidence`.
  - Verification: `npx vitest run` — 22/22 passing, run against the actual local Redis container (`docker compose up -d redis`), not mocked — verified with real `redis-cli PING`/`XADD`/`XRANGE` and `ioredis` connecting before writing any test. `npx tsc --noEmit` clean. Found and fixed two real bugs during review: ioredis emits its own `console.error` on an unhandled connection error (doubled the failure-path test's assertion until an `.on("error", …)` listener was attached), and a default `import Redis from "ioredis"` fails strict `tsc` under Node16 module resolution though `tsx`/vitest silently accepted it — switched to the named import.
  - Notes: `.colaberry/progress.json` updated, all 3 criteria `true`. `.colaberry/enrichment/STORY-002.json` written. Deliberately not built: a standing consumer loop (STORY-006), DLQ/retry on unacked messages (STORY-004/STORY-008), a shared production Redis-client factory (queue.ts takes a connected client via constructor injection).

- [x] STORY-002 follow-up: end-to-end test composing the queue with processJob
  - Date: 2026-09-22
  - Session: CC-20260921-r1ay
  - What changed: `src/endToEnd.test.ts` — composes `queue.ts` (STORY-002) with STORY-001's `processJob.ts` against the real Redis container: enqueue → dequeue → idempotency check → log, as one flow. Closes a gap named explicitly in the STORY-002 confidence note ("processJob() is proven correct in isolation, but composing it with dequeueOne() end to end hasn't been tested together").
  - Verification: `npx vitest run` — 25/25 passing (up from 22), including a re-delivered job through the real queue producing exactly one `job_processed` and one `job_skipped_duplicate`, both with the same correlation ID, and a low-confidence job's `confidence` field surviving the round-trip unchanged. `npx tsc --noEmit` clean. First run passed with no bugs found.
  - Notes: No new acceptance criteria — STORY-002's 3 were already `true`; this only strengthens the evidence behind them. `files_touched`/`tests_added` on the STORY-002 entry updated to include this file.
