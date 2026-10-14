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

## Velora editable draw.io views

- `docs/diagrams/velora-current/velora-architecture.drawio` is the multi-page source; each importable SVG embeds one page, and the combined SVG embeds the complete single `mxfile`. Preserve native figure families and compare against unchanged pages of the same type, not one uniform style across architecture, DFD, ER and sequence views.
- Use the native draw.io exporter through `scripts/diagrams/export_drawio_figures.py` (`DRAWIO_BIN=...`, optional `--png-dir`). Partial SVG converters can omit UML operator tabs, open-ended stores, ER multiplicities or correct routing/word wrapping; their plausible output is not native-template proof.
- Run `scripts/diagrams/validate_reel_exports.py` with the actual paired mobile checkout through `VELORA_MOBILE_ROOT` when needed. Cells belong inside `mxGraphModel/root`; a converter rendering misplaced cells does not mean draw.io will import them correctly.
- Validate visible rendering, editable payload equality and source semantics independently. Guards, frame operands and changed node/edge capabilities need direct current source evidence; valid line bounds alone do not prove the cited behavior. Do not repeatedly shift already-current references through historical Git hunks.
- Inspect fresh native PNGs one page at a time at readable scale. Keep export/source freshness evidence; fixes to embedded metadata still require payload revalidation. Import/editability and SVG preview appearance are different checks.
- Check transparent SVGs on light and dark backgrounds. Fixed white label masks and dark title colors can look correct on white while disappearing or producing white boxes on a dark canvas. Use adaptive colors or an explicit opaque theme according to the requested template; do not claim dark compatibility from light-only inspection.
- Use the existing sequence typography/frame/ref/lifeline/message styles. State practical/template consistency separately from any bounded formal UML/DFD/ER conformance claim.
