---
name: shared-memory
description: Compatibility guidance for selective agentmemory use. Current repository evidence remains authoritative.
---

# Shared Memory Compatibility Shim

Use agentmemory selectively to recover prior engineering decisions, failures, and accepted outcomes when that history materially helps the current task.

## Authority

```text
explicit task requirements
    > current repository code/tests
    > AGENTS.md + repository-specific skills
    > agentmemory
    > external/general research
```

Memory is advisory. If memory conflicts with current code/tests, the repository wins.

## Read policy

Start with a small task-specific query. Do not inject the whole memory store into context.

Skip memory retrieval for trivial edits where history is unlikely to change the solution.

## Write policy

After verified work, save only concise durable lessons such as:

- accepted architecture decisions
- non-obvious invariants
- root causes of important failures
- successful remediation patterns
- outcomes future agents are likely to reuse

Include a commit/PR/issue reference when useful.

Do not store passwords, tokens, secrets, raw transcripts, or reproducible logs merely because they exist.

## Orca

Orca owns the worktree/session/orchestration lifecycle. agentmemory supplies historical context only; it must not become a second source of task ownership or orchestration state.

When Codex Web GPT Full Harness is used, memory may be available through the parent Codex tool surface. Codex Web GPT remains transport only, not a repository worker.
