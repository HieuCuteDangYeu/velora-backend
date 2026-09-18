---
name: repository-orchestrator
description: Compatibility repository-policy wrapper for Orca. Prefer Orca's official orchestration skill for actual Runs, workers, messages, and gates.
---

# Repository Orchestrator Compatibility Shim

This file is a **repository-policy wrapper for Orca**, not an orchestration engine.

Use it only to preserve the workflow contract in repositories bootstrapped by older harness versions. For actual multi-agent execution, delegate immediately to Orca's installed `orchestration` skill.

## GUI-first rule

The human uses the Orca desktop GUI for worktrees, sessions, Run/task visibility, diffs, skills, and ship/review controls. Do not make the user manage ordinary Orca lifecycle from the terminal.

Agents may use Orca CLI operations when required by the official skill.

## Before orchestration

1. read the explicit task
2. inspect current code/tests and `AGENTS.md`
3. check `git status --porcelain` for relevant dirty state
4. use agentmemory only when prior decisions materially help
5. load Orca's live orchestration guide with `agent-harness orca guide` (or the equivalent command documented by the installed Orca skill)

Do not hard-code Orca command syntax from memory.

## Dirty checkout

A newly-created Orca worktree does not inherit uncommitted edits from another checkout.

If the Run depends on dirty local changes, do not silently stash/commit them and do not pretend workers can see them. Ask the user to snapshot/commit the relevant state or continue from an Orca-managed branch/worktree that already contains it.

## Execution policy

Orca owns:

- Runs/tasks/dependencies
- worktrees
- Codex/Antigravity worker sessions
- messages/recovery
- model/effort controls
- status/progress
- decision gates

Use the smallest useful task graph. Do not duplicate implementation ownership across workers or between the parent and a worker.

For substantial work prefer:

```text
implementation -> verification -> independent review -> PASS/BLOCK gate
```

Codex is the default implementation/debugging worker. Use Antigravity when UI/device/visual work or independent review materially benefits.

Do not push, open a remote PR, or merge unless explicitly requested.

## Skills

Use Orca's Skills page / discovered skills / Find Skills surface when available before writing another generic local skill.

Repository-local skills should contain only durable, non-obvious project-specific invariants.

## Never

- revive `agent-harness orchestrate`
- revive the custom `agy` host runner
- use Codex Web GPT as a worker
- create sibling workers outside Orca for an active Run
- trust a worker self-report instead of required verification evidence
- patch Orca/harness internals merely to bypass a product-task blocker
