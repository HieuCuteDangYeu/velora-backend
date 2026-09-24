---
name: diagram-set
description: Generate a coherent repository diagram set from one shared evidence model.
---

# Diagram Set

1. Read the core `repo-diagram` skill, `semantic-ir.md`, and profile index.
2. Map/scout once and create `docs/diagrams/model.spec.yaml`.
3. Select only views that add value; do not mechanically generate every type.
4. Derive every view from stable model IDs.
5. Load each view's own quality profile and renderer strategy.
6. Render + visually review + source-review every view.
7. Cross-view consistency gate: names, kinds, relation direction/semantics, real
   boundaries, palette/legend meaning.
8. Deliver an ordered `docs/diagrams/README.md`.

A set is several views of one model, not independent pictures.
