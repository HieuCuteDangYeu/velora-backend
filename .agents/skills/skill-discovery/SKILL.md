---
name: skill-discovery
description: Compatibility guidance for choosing an existing skill before creating repository-local guidance. Prefer Orca's Skills UI and built-in discovery surfaces.
---

# Skill Discovery Compatibility Shim

Do not maintain a second generic skill marketplace inside this repository.

## Preferred path

Use, in order:

1. Orca's Skills page and installed skill list
2. the active agent's discovered skill picker
3. Orca's built-in skill discovery / Find Skills surface when available
4. maintained external skills with inspectable provenance
5. repository-local skills only for durable project-specific knowledge

The human should normally install/update skills through the Orca GUI. Agents may use Orca's version-matched skill commands when automation is required.

## Before recommending a skill

Inspect the current repository and active task first. Choose skills for the task, not for every technology present somewhere in the repo.

Prefer one strong maintained skill over several overlapping ones.

Consider provenance, maintenance, supported agents, hooks/scripts/binaries, network access, context cost, and overlap with existing policy before installation.

Discovery is read-only by default. Do not install a third-party skill unless the user explicitly asks to install/apply it.

## When a local skill is justified

Create or update `.agents/skills/...` only for stable, non-obvious repository-specific knowledge that future agents repeatedly need, such as:

- authentication/authorization invariants
- service ownership boundaries
- messaging/outbox/idempotency guarantees
- persistence conventions
- media-processing workflows
- project-specific deployment/release procedures

Do not create local skills for generic orchestration, TypeScript/framework knowledge, testing guidance, memory usage, or UI expertise when a maintained skill already covers them.
