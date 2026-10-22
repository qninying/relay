# How the Platform Project Fits the 7-Layer Reference Architecture

**Project:** Ellis, the Platform Automation & Reliability Agent (Colaberry Project Factory, platform domain)
**Reference:** the 7-Layer Architecture from *Trust Before Intelligence*, as used in the Colaberry platform's own governance program
**Date:** 2026-10-22
**Status:** Ellis is in design. "Exists today" means the platform already has it; "Planned" means Ellis will add or use it.

---

## The short version

Think of the platform as a large office full of automated workers (software agents). Ellis is the reliability officer for that office. It doesn't do the office's work. It watches the workers, notices when something goes wrong, works out why, and reports to a person who decides what to do.

The 7-layer architecture is a checklist for building trustworthy AI. Each layer answers one question, from "where is the information kept?" at the bottom to "how do people use it?" at the top. If any layer is weak, the whole system becomes harder to trust.

---

## The mapping at a glance

| # | Layer | What it is for | Where it shows up in the platform project |
|---|---|---|---|
| 1 | Multi-Modal Storage | Keeping all the information the system needs, safely and in one dependable place | **Exists today:** the platform's Postgres database, holding the agent registry (one record per agent), activity logs, scheduled-job run logs, audit logs and error records. **Planned:** Ellis's own memory, stored separately so it never mixes with the platform's records. |
| 2 | Real-Time Data | Getting fresh information to the system as things happen, not days later | **Exists today:** the scheduler (which starts jobs on a timer), run instrumentation (which records each run's start, finish and failure) and health checks every few minutes. **Planned:** Ellis's perception layer, which reads these signals as they arrive. |
| 3 | Semantic | Giving everyone the same meaning for the same words | **Exists today:** the platform capability catalog (48 named capabilities, each with a plain description) and the legacy agent classification. **Planned:** the legacy migration plan, which gives each of the 38 inherited agents one agreed status (merged, kept, superseded, retired or unknown). |
| 4 | Intelligence | The "thinking" part: understanding a situation and deciding what it means | **Planned:** Ellis's reasoning engine (the AI model) and its planner, which work out the likely cause of a problem and how confident they are. **Exists today:** the platform's shared AI call wrapper, which every AI call goes through. |
| 5 | Governance | Rules about what the system may and may not do, and who must approve | **Exists today:** the execution policy, which already forbids agents from deploying to production, pushing code to the main branch or sending email. Autonomy levels R0 to R5 cap how independent each capability can be. **Planned:** Ellis starts read-only at R0, uses only approved tools, and every tool grant is approved by K.D. and A.M. |
| 6 | Observability | Being able to see what the system did, how well, and at what cost | **Exists today:** scattered logs (activity, scheduled runs, AI calls). The platform's own audit names this as one of its two biggest gaps. **Planned:** Ellis's first task is a logging coverage audit: what is recorded well, what is missing. Every Ellis run records its cost, accuracy and speed. |
| 7 | Orchestration | Bringing the pieces together so people can actually use the result | **Exists today:** the portal, the agent registry and the scheduler that coordinates the platform's agents. **Planned:** Ellis's orchestration runtime, which runs its plans, and its reports: a weekly reliability briefing and incident reports for the manager. |

> **A note on names:** Colaberry's documents use two sets of names for the upper layers. Layer 4 is also called "Intelligence Orchestration & Retrieval", layer 5 "Agent-Aware Governance", layer 6 "Observability & Feedback", and layer 7 "Self-Service Data Products". They mean the same layers.

---

## Each layer in plain terms

### Layer 1: Multi-Modal Storage, the filing cabinet
**In simple terms:** this is where everything is written down. If the records are incomplete or scattered, no amount of clever AI can give a reliable answer.

**For this project:** the platform already keeps records of every agent, every job it runs and every error. Ellis will read those records where they already are and never make copies. Ellis's own notes, what it looked at and what it concluded, go in a separate drawer so the two never get confused.

### Layer 2: Real-Time Data, the news feed
**In simple terms:** a reliability officer who only hears about problems a week later is not much use. This layer makes sure information arrives while it still matters.

**For this project:** the platform's scheduler and health checks already produce a steady stream of "this job ran", "this job failed" and "this job is late" signals. Ellis listens to that stream. That is how it can notice a problem before a user reports it.

### Layer 3: Semantic, the shared dictionary
**In simple terms:** if one team calls something an "outage" and another calls it a "blip", reports become confusing. This layer makes sure words mean the same thing to everyone, people and machines alike.

**For this project:** the platform has a catalog that names and describes each capability, and a classification of the old agents it inherited. A lot of the early work on this project was cleaning up that dictionary: deciding, for each of the 38 inherited agents, whether it is still needed, merged into something newer, or unknown. Three are still unknown, and they are held rather than guessed at.

### Layer 4: Intelligence, the brain
**In simple terms:** this is the part that reads the evidence and works out what is going on. It is what makes Ellis an "agent" rather than a simple alarm.

**For this project:** Ellis uses an AI model to reason about problems and to plan its own steps, instead of following a fixed script. When the evidence is thin, it is designed to say "I don't know" rather than guess.

### Layer 5: Governance, the rulebook and the sign-off
**In simple terms:** this layer decides what the system is allowed to do on its own and what needs a person's approval. It is the main reason people can trust an AI system with real work.

**For this project:** Ellis begins strictly read-only. It can look and report, but it cannot change anything. The platform already blocks all agents from the riskiest actions (releasing software, changing the main code, sending emails). Turning agents on or off, approving tools, and deciding Ellis's own level of independence all stay with people.

### Layer 6: Observability, the dashboard and the receipts
**In simple terms:** you can't fix what you can't see. This layer lets people check what the system did, whether it was right, and what it cost.

**For this project:** this is where Ellis matters most. The platform's own audit says observability is one of its weakest layers: the logs exist but are spread out, and nobody has checked whether they hold enough detail to diagnose a problem. Ellis's first job is exactly that check. Ellis also keeps receipts on itself: every run records how much it cost, how accurate it was and how long it took.

### Layer 7: Orchestration, the front desk
**In simple terms:** this is where all the layers come together into something people actually use, such as a report, a dashboard or an answer to a question.

**For this project:** Ellis turns what it finds into plain reports for its manager, with every claim linked to the record it came from. The first of these is a weekly reliability briefing. Ellis drafts it; a person decides what to do with it, and the platform's existing briefing service handles delivery.

---

## Why this matters

- **Ellis strengthens the platform's weakest layers.** The platform's own governance program names layers 5 (governance) and 6 (observability) as its biggest gaps. Ellis is designed around both: it starts by auditing what is visible, and it works inside strict rules.
- **Ellis builds on what exists.** Every layer already has some platform foundation. Ellis reads and connects it rather than rebuilding it.
- **Trust is earned layer by layer.** Ellis starts with the least independence (read-only, R0) and only gains more once it has proven itself against tests a person checks.

---

## Sources
- Colaberry platform: `docs/ai-governance/TBI_COMPLIANCE_PROGRAM.md` (section 2.3, the 7-layer mapping for the platform today) and `docs/architecture/refactored-delivery-os/TARGET_ARCHITECTURE.md` (canonical layer names)
- Platform capability catalog for the platform domain (48 capabilities, 38 legacy records)
- Project discovery stories 1 to 5, the legacy migration plan, and BRD draft v0.8
