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
