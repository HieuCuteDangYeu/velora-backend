# Renderer strategy

Choose by **semantic fidelity first**, then portability and visual quality. Never
change the meaning of a diagram to fit a renderer.

| Diagram | Preferred | Fallback |
|---|---|---|
| C4 landscape/context/container/component | Native SVG for polished-overview; Mermaid + ELK for notation-first C4 | PlantUML / Graphviz preview |
| C4 dynamic | Mermaid sequence | PlantUML sequence |
| Sequence | Mermaid simple; PlantUML complex | the other |
| Class | PlantUML | Mermaid classDiagram |
| ER | Mermaid erDiagram | PlantUML |
| State | Mermaid stateDiagram-v2 | PlantUML |
| Dataflow | Mermaid + ELK | Graphviz dot |
| Deployment | PlantUML | Mermaid flowchart |
| Call graph | Graphviz dot | Mermaid flowchart |
| Use case | Mermaid native if >=12 | PlantUML |
| Flowchart | Mermaid + ELK | Graphviz dot |
| Swimlane | Mermaid native if >=11.16 | flowchart lanes / PlantUML activity |

Record preferred and fallback renderer in the spec. For `polished-overview` static architecture,
read `visual-compiler.md`: the native SVG renderer is preferred because it owns node
coordinates and edge routes and can be inspected mechanically.

## Native polished architecture renderer

`render_architecture_svg.py` is intentionally narrow: static C4/high-level architecture
only. It uses the evidence spec directly, performs layered placement, barycentric node
ordering and orthogonal obstacle-aware routing, then emits stable SVG metadata for the
geometry analyzer. Do not use it for sequence/class/ER/state notation.

## Mermaid capability gate

Do not assume the latest syntax exists locally. Probe `mmdc --version` when installed.

- Mermaid >=11.16: native swimlane may be used.
- Mermaid >=12: native use-case syntax may be used; modern builds also support ELK as
  a first-class layout.
- Older/unknown: use stable flowchart/class/ER/state/sequence syntax and fallbacks.

For non-trivial directed graphs, prefer explicit Mermaid frontmatter:

```yaml
---
config:
  layout: elk
  look: classic
  theme: base
---
```

Do not use `handDrawn` for engineering documentation unless requested.

## PlantUML

Prefer when UML semantics are the point: class relationships, complex sequence
fragments, rich deployment, or use-case fallback. Centralise styling; do not scatter
one-off skin tweaks through generated source.

## Graphviz

Prefer `dot` for call/dependency graphs. Useful controls: `rankdir`,
`rank=same`, `group`, and `splines=polyline`. Clusters must be real boundaries
or explicitly presentation-only.

Graphviz is not a UML semantics engine.

## Fallback invariant

A fallback must preserve node identity, direction, relation semantics, async/sync,
and any relevant order/cardinality/guard. If it cannot, report the renderer limitation
instead of degrading the diagram silently.
