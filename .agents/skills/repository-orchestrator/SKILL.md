---
name: repository-orchestrator
description: Apply repository-specific orchestration policy while Orca owns multi-agent Runs, worktrees, worker sessions, messages, and decision gates.
---

# Repository Orchestrator

Use this skill as the repository-policy wrapper for Orca orchestration. Orca is the execution engine; this skill supplies the repository rules that must survive across Orca versions and worker types.

## Read first

Before planning:

1. read the explicit task
2. inspect current code and tests
3. read `AGENTS.md` and only relevant repository skills
4. recall agentmemory only when prior decisions materially help
5. use external research or `skill-discovery` only when repository evidence is insufficient

Authority:

```text
explicit task requirements
    > current code/tests
    > AGENTS.md + repository skills
    > agentmemory
    > general research
```

## Load Orca before mutating orchestration state

Orca's command surface is versioned. Do not hard-code old orchestration commands from memory.

1. verify the CLI with `agent-harness orca status`
2. if the runtime is not running, try `agent-harness orca open` once
3. load the live guide with `agent-harness orca guide`
4. follow that live guide for Run, task, supervised-worker, messaging, model/effort, and gate operations
5. prefer Orca JSON output when the live guide supports it

If the CLI or live orchestration guide remains unavailable, stop and report the problem. Do not fall back to the removed `agent-harness orchestrate` runtime, ad-hoc terminal prompting, or a custom worker launcher.

## Dirty working-tree rule

Orca worktrees start from Git refs/commits and are clean checkouts. Uncommitted changes in the caller checkout are not automatically inherited by a newly-created Orca worktree.

Before creating an Orca Run, inspect `git status --porcelain` in the source checkout. If relevant uncommitted changes exist:

- do not pretend Orca workers can see them
- do not stash, commit, or mutate the caller checkout without permission
- ask the user to commit/snapshot the relevant state, or continue from an Orca-managed worktree/branch that already contains it

Unrelated dirty files may remain untouched if the Run does not depend on them.

## Plan

Build the smallest useful task graph. Split only at real ownership, dependency, or independent-verification boundaries.

Use Orca task-level workers such as:

- **Codex** for implementation, debugging, repository analysis, tests, or review
- **Antigravity** for UI/device-oriented work, focused implementation, testing, or independent review when useful

Use per-worker model and reasoning-effort overrides only through the live Orca guide. Do not assume a model name or effort value is accepted merely because another session supports it.

Do not run duplicate workers on the same implementation task unless the user explicitly wants competing approaches. Orca owns task-level concurrency. A worker may use its own internal subagents only when that remains inside its assigned task and does not duplicate sibling Orca work.

For substantial implementation, include:

1. implementation tasks
2. meaningful verification tasks/checks
3. a `skill-maintenance` task when durable repository knowledge may have changed
4. an independent final review task
5. a final decision gate that blocks completion when review or verification fails

Do not configure automatic remote push/merge unless the user explicitly asked for it.

## Execute with Orca

Use the live Orca orchestration guide to create and run the task graph. Keep these repository policies regardless of the current Orca command syntax:

- every task works in an Orca-managed isolated worktree/session
- workers read that worktree's `AGENTS.md` and relevant skills before editing
- workers do not edit the caller checkout
- task prompts include acceptance criteria, constraints, non-goals, and verification expectations
- dependencies are explicit
- failed verification blocks dependent delivery
- final review is independent from the implementation worker when practical
- delivery/merge stays local unless remote operations were explicitly authorized

If a worker stalls, use Orca's current messaging/recovery controls from the live guide. Do not silently move the same task to another executor unless the user or plan explicitly authorizes reassignment.

## Android/device work

When Android verification is relevant and Orca's Android skill is installed, load the current `orca-emulator-android` guide and use Orca's adb-connected device/emulator workflow. Device access is a host capability; do not claim ADB verification if the selected worker/runtime cannot see the device.

## Shared memory and repository skills

Ponytail, agentmemory, and repository skills remain complementary to Orca:

- use repository skills for durable project-specific procedures and invariants
- use agentmemory selectively for prior decisions that materially help
- follow Ponytail minimal-change/YAGNI guidance when available
- never simplify away auth, validation, transactions, concurrency/idempotency, data integrity, security, error handling, or accessibility
- save only concise, durable, verified lessons after meaningful work

## Final review and completion

Before completion:

1. ensure required verification actually ran
2. inspect the integrated diff/result in Orca
3. run the independent review task
4. require the final decision gate to pass
5. confirm no unauthorized remote push/merge occurred
6. report the changed files, verification results, and remaining risks

## Never do these

- use the removed `agent-harness orchestrate` runtime
- launch the removed custom `agy` host runner
- use `codex-web-gpt` as a repository worker
- create sibling implementation workers outside Orca for an active Orca Run
- assume caller uncommitted changes were copied into Orca worktrees
- trust an agent self-report instead of required verification evidence
- push or merge remotely unless explicitly requested
- patch Orca or harness internals merely to bypass a product-task blocker

Optimize for:

```text
correctness > architecture consistency > simplicity > testability > observability > speed
```
