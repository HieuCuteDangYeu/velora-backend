---
name: skill-maintenance
description: Review verified repository changes and update local skills only when durable project-specific engineering knowledge actually changed.
---

# Skill Maintenance

Repository skills should stay rare and small.

After a substantial verified change, determine whether it modified a stable project-specific invariant or workflow. Return one of:

- `NO_SKILL_CHANGE`
- `UPDATE_SKILL <skill-name>`
- `CREATE_SKILL <skill-name>`
- `REMOVE_SKILL <skill-name>`

`NO_SKILL_CHANGE` should be the normal result.

Update/create a local skill only for durable changes to things such as:

- architecture boundaries
- security/auth invariants
- persistence ownership/conventions
- messaging/outbox/idempotency rules
- operational/release workflows
- domain constraints future agents must know

Do not update local skills for one-off fixes, refactors, renames, temporary migrations, generic framework behavior, or anything already covered by Orca/installed Agent Skills.

Before creating a new local skill, use Orca's Skills UI / built-in discovery surfaces to check whether a maintained skill already covers the capability.

Prefer editing or shrinking an existing skill over adding an overlapping one.
