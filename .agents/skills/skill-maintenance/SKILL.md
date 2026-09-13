---
name: skill-maintenance
description: Review repository changes, commits, or pull requests to determine whether durable architecture or workflow knowledge changed and whether existing Agent Skills should be updated or a new skill should be proposed. Use after major feature work, architecture changes, or when auditing whether repository skills remain accurate.
---

# Skill Maintenance

Inspect the actual repository change and determine whether it introduces or modifies reusable engineering knowledge.

Do not treat ordinary implementation details as skill-worthy.

## Possible outcomes

Return one of:

- `NO_SKILL_CHANGE`
- `UPDATE_SKILL <skill-name>`
- `CREATE_SKILL <skill-name>`
- `REMOVE_SKILL <skill-name>`

## Update a skill only when

The change modifies a stable:

- architectural invariant
- cross-service convention
- security requirement
- persistence convention
- messaging/event workflow
- operational workflow
- domain constraint

Do not update skills for:

- one-off bug fixes
- variable/function renames
- implementation details
- temporary migrations
- information obvious from local code
- generic framework behavior

When changes are necessary, keep the skill smaller than before when possible. Prefer editing an existing skill over creating overlapping skills.
