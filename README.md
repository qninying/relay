# Relay — AI Agent Job Orchestration Platform

Relay fans out large batches of work — research, classification, and
summarization — to a pool of independent AI agent workers pulling from a
durable job queue, so a batch of thousands of items can run unattended and
still be trusted. Every job is idempotent, every external API call sits
behind a circuit breaker, every exhausted-retry job lands in a dead-letter
queue instead of vanishing, and every stage is traced end to end by a
correlation ID.

That last part is the design's actual center of gravity. A pipeline that
"mostly works" on a batch of 5,000 items is not trustworthy at that scale —
what matters is that every item is accounted for, failures are visible and
triaged rather than silently dropped, and the system degrades predictably
instead of catastrophically when an upstream dependency misbehaves. Relay is
built around proving that boundary in a real distributed system, not a
single process pretending to be one.

An MCP server exposes job submission, status and SLO queries, and
dead-letter-queue triage as tools, so the pipeline can be operated by an AI
agent directly, alongside a dashboard for human operators.

## Status

This repository is freshly scaffolded. Architecture, stories, and the
implementation itself land in subsequent work — see
[`BuildIdeaPrompt.txt`](BuildIdeaPrompt.txt) for the design brief this build
starts from.
