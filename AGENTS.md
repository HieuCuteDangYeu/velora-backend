# Engineering Workflow

## Instruction priority

Apply instructions in this order:

1. explicit user/task requirements
2. current repository code and tests
3. repository `AGENTS.md` / more specific nested `AGENTS.md`
4. relevant repository-specific skills
5. agentmemory
6. external/general research

Never let a lower-priority source override a higher-priority one.

## Orca GUI is the human control plane

Use the Orca desktop GUI as the normal workspace for:

- repositories and worktrees
- agent sessions
- Runs/tasks and progress
- model/effort choices exposed by Orca
- browser/device/design surfaces
- diff review
- skill visibility/updates
- commit/push/PR controls when explicitly authorized

Do not force the user to mirror normal GUI operations with `agent-harness` commands.

Agents may use Orca's CLI and installed Agent Skills for typed automation and live version-matched guides.

## When to orchestrate

For a small focused task, use one agent session directly unless splitting materially improves correctness, speed, or independent verification.

For substantial work or when the user explicitly asks for multi-agent execution, use Orca's official `orchestration` skill. Before mutating Run/task state, load Orca's live, version-matched guide (`agent-harness orca guide` or the equivalent command documented by the installed Orca skill).

Orca owns task-level:

- Runs/task graphs
- worktrees
- worker sessions
- messages/recovery
- model and reasoning-effort selection
- status/progress
- decision gates

Do not create a second orchestration DAG underneath Orca.

## Worker policy

- Codex is the default implementation, debugging, repository-analysis, testing, and code-review worker.
- Use Antigravity when UI, device, emulator, visual verification, focused implementation, or independent review would materially benefit.
- Use other Orca-supported agents only when they provide a meaningful capability or independence boundary.
- Codex Web GPT is optional parent transport only; never use it as a repository worker.
- Do not launch duplicate sibling workers on the same implementation unless the user explicitly requests competing approaches.
- The parent must not directly implement the same task while an Orca worker owns it.

For substantial implementation, prefer the smallest useful graph:

```text
implementation -> verification -> independent review -> PASS/BLOCK gate
```

Split further only at real ownership or dependency boundaries.

## Skill policy

Use existing Orca/Agent Skills before writing generic local skills.

Search in this order:

1. Orca Skills page / installed skills
2. the active agent's discovered skill picker
3. Orca's built-in skill discovery / Find Skills surface when available
4. maintained external skills with inspectable provenance
5. repository-local skills only for durable project-specific knowledge

Do not create local skills for generic orchestration, generic skill discovery, generic language/framework knowledge, or generic memory usage when a maintained skill already covers them.

Repository-local skills are justified for stable, non-obvious project invariants such as authentication rules, service ownership, event/outbox/idempotency guarantees, persistence conventions, media pipelines, or release procedures.

Load only skills relevant to the active task.

## Context acquisition

Before implementation:

1. understand the requested behavior
2. inspect the actual current execution path
3. locate relevant tests
4. find analogous existing implementations
5. determine the smallest safe change
6. identify assumptions that materially affect correctness
7. use agentmemory only when prior decisions/failures materially help
8. use external research only when repository evidence is insufficient or the task explicitly asks for it

Do not implement solely from an issue description, memory summary, or stale documentation when the repository can answer the question.

## Dirty working-tree rule

New Orca worktrees start from Git refs/commits. Uncommitted edits in another checkout are not automatically inherited.

Before starting a Run that depends on current local edits, inspect `git status --porcelain` or equivalent.

If relevant uncommitted changes exist:

- do not pretend workers can see them
- do not silently stash, commit, or mutate the caller checkout
- ask the user to commit/snapshot the relevant state, or continue from an Orca-managed worktree/branch that already contains it

Unrelated dirty files should remain untouched.

## Implementation discipline

Prefer:

existing implementation -> existing utility -> platform/native functionality -> installed dependency -> smallest new implementation

Rules:

- keep changes surgical
- do not perform unrelated refactors
- preserve existing architecture and conventions
- reuse existing abstractions before adding new ones
- do not add dependencies without necessity
- preserve public interfaces unless the task explicitly changes them
- follow relevant repository-specific skills
- follow Ponytail/minimal-change/YAGNI guidance when available

## Safety and correctness

Simplicity must never remove required:

- authentication
- authorization
- trust-boundary validation
- transaction safety
- concurrency protection
- idempotency guarantees
- data-integrity checks
- error handling
- security controls
- accessibility requirements

Never put secrets into memory, task packets, logs, or prompts intended for unrelated workers.

## Verification

Run the narrowest meaningful checks first:

1. relevant tests
2. typecheck
3. lint
4. integration tests
5. broader suites only when necessary

For substantial Orca Runs, keep verification and final review as explicit tasks. A worker saying "tests pass" is not sufficient when evidence is required.

Failed required verification blocks PASS.

Use an independent reviewer when practical.

## Memory

agentmemory is advisory and selective.

Use it to avoid repeating already-solved investigations, not as a substitute for current repository evidence.

Save only concise, verified lessons future agents are likely to reuse. Prefer accepted decisions/root causes/outcomes with a commit, PR, or issue reference when available.

Do not store secrets, raw transcripts, or reproducible logs merely because they exist.

## Scope and remote operations

Do not fix unrelated problems discovered during the task; report them separately when materially important.

By default, delivery stays local. Do not push, create a remote PR, or merge unless the user explicitly requests it.

When shipping is authorized, prefer Orca's GUI diff/commit/push/PR surfaces so the human can inspect the final integrated result.

## Completion

Report concisely:

1. implementation summary
2. files changed
3. verification commands
4. verification results
5. remaining risks/assumptions

Never claim a command, test, review, or device check succeeded unless it actually ran successfully.
