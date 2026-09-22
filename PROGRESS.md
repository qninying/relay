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
