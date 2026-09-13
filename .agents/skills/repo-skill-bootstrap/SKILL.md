---
name: repo-skill-bootstrap
description: Analyze a software repository and identify, propose, create, or update concise repository-specific Agent Skills for stable architecture, workflows, invariants, and domain conventions. Use when installing the engineering harness into a repository, onboarding agents to an unfamiliar codebase, or refreshing skills after significant architectural changes.
---

# Repository Skill Bootstrap

Analyze the repository before creating skills.

The purpose is not to document the repository. The purpose is to expose non-obvious knowledge that materially changes how future coding agents should make decisions.

## Classify discovered knowledge

Classify each candidate rule as one of four categories.

### AGENTS.md

Use `AGENTS.md` when the rule applies to nearly every engineering task.

### Agent Skill

Create a skill when the knowledge is specialized and relevant only to certain tasks, such as authentication invariants, messaging architecture, event publication rules, media processing, database ownership, or deployment procedures.

### Deterministic tooling

Prefer linting, tests, CI, schemas, formatters, or static analysis when a rule can be enforced mechanically. Do not consume LLM context for something deterministic tooling can verify.

### Documentation

Keep information as documentation when it primarily helps humans and does not materially alter agent decisions.

## Repository discovery

Inspect relevant sources including:

- `AGENTS.md`
- README and architecture documentation
- package/workspace manifests
- service/module structure
- configuration
- persistence layer
- messaging/event infrastructure
- authentication/authorization
- background jobs
- tests
- CI workflows
- recent meaningful git history

Search for repeated implementation patterns before inferring conventions. Do not infer architecture from file names alone.

## Skill creation threshold

Create or propose a skill only when at least one condition holds:

1. The repository contains a non-obvious architectural invariant.
2. Violating the pattern would create correctness or security problems.
3. Multiple parts of the repository follow the same specialized workflow.
4. Agents repeatedly need the same project-specific explanation.
5. The knowledge is reusable across multiple future tasks.

Do not create a skill when:

- it is generic language/framework knowledge
- it merely restates source code
- it applies to only one temporary issue
- deterministic tooling can enforce it
- it duplicates `AGENTS.md`
- it duplicates Ponytail
- another existing skill already covers it

## Skill design

Use `.agents/skills/<skill-name>/SKILL.md` with lowercase hyphenated names.

Keep `SKILL.md` concise. Put large supporting material under `references/` and deterministic reusable helpers under `scripts/`.

Assume the agent already understands common languages, frameworks, databases, and infrastructure. Explain only what is specific to this repository.

## Generation workflow

First produce a proposal containing:

- skill name
- trigger
- repository evidence
- important invariants
- why it deserves a skill
- likely source files

Do not create skills during proposal-only requests.

When explicitly asked to apply the proposal:

1. Prefer updating an existing skill over creating a near-duplicate.
2. Use the host's built-in skill creator when available.
3. Otherwise create a valid Agent Skill directly.
4. Write skills under `.agents/skills/`.
5. Validate generated skills when validation tooling is available.
6. Review generated skills for duplicated guidance.

Never modify application code as part of skill generation unless the user explicitly requests it.
