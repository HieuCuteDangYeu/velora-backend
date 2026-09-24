---
name: diagram-review
description: Review a repository diagram against source, semantic type rules, renderer fidelity, abstraction, and rendered visual quality.
---

# Diagram Review

1. Read `../repo-diagram/SKILL.md`.
2. Read the diagram plus its spec/evidence when present.
3. Identify the diagram type and load its profile from
   `../repo-diagram/references/profiles/`.
4. Render with `../repo-diagram/scripts/render_any.sh` when source format is
   mmd/puml/dot; use `validate_mermaid.sh` for Markdown Mermaid blocks.
5. Apply `diagram-reviewer-procedure.md`, including type-specific visual acceptance.
6. If a shared `model.spec.yaml` exists, verify the view against it.
7. Report Blocking / Should fix / Optional. Do not edit unless the user asked for fixes.

If evidence is absent, say truth cannot be fully verified; semantic and visual review
can still proceed.
