---
name: repo-skill-bootstrap
description: Create or refresh only durable repository-specific Agent Skills after existing Orca/Agent Skills have been considered first.
---

# Repository Skill Bootstrap

Use this only when the repository contains stable knowledge that generic Orca/Agent Skills cannot provide.

## First use existing skills

Before creating anything local, check Orca's Skills page, the active agent's discovered skills, and Orca's built-in skill discovery / Find Skills surface when available.

Do not duplicate generic orchestration, language/framework knowledge, testing, UI/UX, security, or memory guidance when a maintained skill already covers it.

## Create a repository skill only when

At least one of these is true:

1. the repository has a non-obvious architectural invariant
2. violating the rule risks correctness/security/data integrity
3. several modules/services follow the same specialized workflow
4. agents repeatedly need the same project-specific explanation
5. the knowledge is stable enough to matter across future tasks

Examples:

- project-specific auth/authorization rules
- event/outbox/idempotency guarantees
- service/data ownership boundaries
- persistence conventions
- media-processing pipelines
- repository-specific deployment/release procedures

## Do not create a skill when

- nearby code/tests already make the rule obvious
- deterministic tooling can enforce it better
- it applies only to one temporary issue
- it merely restates documentation
- it duplicates `AGENTS.md`
- it duplicates Ponytail
- it duplicates an installed maintained skill

## Placement

Use `AGENTS.md` for rules that apply to nearly every engineering task.

Use `.agents/skills/<name>/SKILL.md` only for specialized project knowledge that should load on relevant tasks.

Prefer tests, linting, schemas, CI, formatters, and static analysis when the rule can be enforced mechanically.

## Workflow

For proposal-only requests, first return:

- proposed skill name
- trigger
- repository evidence
- important invariants
- why it deserves a local skill
- likely source files

Do not create the skill until the user asks to apply the proposal.

When applying it, keep the skill concise, update an existing skill instead of creating an overlap, and never modify application code unless the user explicitly asks.
