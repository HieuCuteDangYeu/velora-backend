---
name: repository-orchestrator
description: Plan and execute substantial repository work with Codex native subagents plus Antigravity (`agy`), isolated worktrees, deterministic verification, skill maintenance, and final review.
---

# Repository Orchestrator

Turn the user's request into the smallest safe task graph and execute it without making the user manage agents, worktrees, or plan JSON.

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

## Executors

Use the actual available executors:

- **Codex (`codex`)** — use Codex's native subagent tools exposed by the current host (`spawn_agent`, `wait_agent`, `close_agent`, or their namespaced equivalents). Do not launch a nested `codex` CLI process.
- **Antigravity (`agy`)** — use for independent UI-oriented work, focused tests, or secondary implementation/review when useful. Check `command -v agy` before assigning it.

If native Codex subagent tools are unavailable, assign Codex work to `agy` when available. If neither native Codex subagents nor `agy` are available, report that repository orchestration cannot run instead of inventing another execution path.

`codex-web-gpt` is only the parent ChatGPT Web transport. Never launch or repair it as a worker.

## Plan

Build a compact schema-version-1 plan internally. Split only at real ownership or dependency boundaries.

Each task contains:

- `id`
- `agent`: `codex` or `agy`
- focused task prompt
- `dependsOn`
- acceptance criteria
- constraints/non-goals
- deterministic verification commands

Respect `maxParallel`; do not spawn more live workers than the plan allows.

For substantial implementation, add a final `skill-maintenance` task after implementation/tests and before final review. It may change only `.agents/skills/` and should normally return `NO_SKILL_CHANGE` unless durable repository knowledge changed.

## Execute

If the user asked only for a plan, show the concise graph and stop.

If implementation was requested:

1. save the internal plan under `${TMPDIR:-/tmp}/agent-harness-plans/`
2. run `agent-harness orchestrate prepare <plan.json>` and capture the run id
3. run `agent-harness orchestrate ready <run-id>`
4. for each ready `codex` task, run `agent-harness orchestrate task <run-id> <task-id>`, then pass the printed task packet to a native Codex subagent
5. for each ready `agy` task, run `agent-harness orchestrate agy <run-id> <task-id>`
6. wait for native Codex subagents; when one completes, run `agent-harness orchestrate complete <run-id> <task-id>`; if it errors, run `agent-harness orchestrate fail <run-id> <task-id> <reason>`
7. close completed native subagents so they do not consume the host concurrency limit
8. repeat `ready` until every implementation task is successful or the run is blocked
9. run final review
10. after review passes, run `agent-harness orchestrate deliver <run-id>`
11. inspect the applied caller-worktree diff and report the result

The helper snapshots the caller's current committed, modified, deleted, and untracked non-ignored files into a temporary shadow repository. Every task gets an isolated worktree from that shadow repository. Deterministic verification and integration are performed by the helper, not trusted from an agent self-report.

## Native Codex task rules

A native Codex subagent inherits the parent session, so always give it the full task packet printed by `agent-harness orchestrate task`. The packet contains the absolute isolated worktree path.

The subagent must:

- work only in that worktree
- read that worktree's `AGENTS.md` and relevant skills
- not edit the caller checkout
- not delegate to another agent
- not push, merge, or create a PR
- leave the worktree ready for harness verification

Use `send_input`/follow-up messaging only when a running subagent genuinely needs correction. Do not duplicate the same task with another agent merely because it is slow.

After reconnecting to a Codex/Web session, inspect existing live agents and `agent-harness orchestrate status latest` before spawning anything new.

## Final review

If the plan review agent is `codex`:

1. run `agent-harness orchestrate review-task <run-id>`
2. pass the printed review packet to a native Codex subagent
3. require its final line to be exactly `VERDICT: PASS` or `VERDICT: BLOCK`
4. record it with `agent-harness orchestrate review <run-id> PASS|BLOCK`
5. close the reviewer subagent

If the review agent is `agy`, run `agent-harness orchestrate review-agy <run-id>`.

Deliver only after all tasks succeeded and final review returned `PASS`.

## Runtime behavior

Ponytail and agentmemory are host integrations; do not create setup tasks for them.

- follow Ponytail minimal-change guidance when available
- never simplify away auth, validation, transactions, concurrency/idempotency, data integrity, security, error handling, or accessibility
- let agents query shared memory selectively when useful
- save only concise, durable, verified lessons after meaningful work

If device/emulator validation is blocked by the outer sandbox, report that limitation after completing deterministic checks that are available. Do not change harness infrastructure or bypass orchestration to work around it.

## Never do these

- launch nested `codex exec` workers
- use native subagents without isolated harness worktrees for implementation
- use `codex-web-gpt` as a worker
- create temporary compatibility wrappers or patch harness internals during a product task
- directly implement the same task while an assigned worker is active
- push or merge remotely unless explicitly requested

Optimize for:

```text
correctness > architecture consistency > simplicity > testability > token efficiency > speed
```
