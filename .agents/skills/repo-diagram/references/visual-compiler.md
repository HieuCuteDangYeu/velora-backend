# Visual compiler

Repo Diagrammer separates **semantic correctness** from **geometric correctness**.

The evidence IR answers *what exists and what relates*. The visual compiler answers
*where it is placed, how edges are routed, and whether the result is readable*.

## Pipeline

```text
Evidence IR
  → view model
  → layout rows / ordering
  → renderer
  → geometry analyzer
  → automatic presentation repair
  → render again
  → visual acceptance
```

A visual review is not considered complete merely because source syntax parses.

## Native high-level architecture renderer

For static C4/high-level architecture views using `presentation.style:
polished-overview`, prefer `render_architecture_svg.py` when PyYAML is available.

It owns node geometry instead of delegating the entire composition to Mermaid:

- deterministic layered placement;
- barycentric ordering to reduce crossings;
- candidate-scored orthogonal edge routing;
- obstacle-aware perimeter routing for long cross-layer edges;
- route scoring that penalizes node hits, crossings, long shared corridors, bends and route length;
- geometry-aware label placement that avoids nodes, labels and unrelated edges;
- distributed edge ports for high-degree nodes instead of one congested center port;
- primary-path-first routing and emphasis when `view.primary_path` is supplied;
- adaptive node height with glyph-aware width estimation and wrapped responsibility copy;
- adaptive canvas sizing to reduce dead whitespace on small views;
- stable `data-node-id` and `data-edge-id` metadata for machine inspection.

Use Mermaid/PlantUML/Graphviz for diagram types where their notation semantics are
the main value. The native renderer is intentionally not a replacement for Sequence,
Class, ER, State, or rich UML Deployment notation.

## Automatic repair loop

Use `render_polished.py` as the default entry point for polished static architecture.
It runs the native renderer and strict geometry analyzer, then retries with progressively
roomier spacing when the Blocking defects are layout-repairable.

Repair passes may change only presentation geometry. They must never change node
identity, relation direction, grouping membership, protocol, evidence, or architectural
boundaries.

The loop stops immediately for defects such as unrelated-node region capture or
ambiguous region overlap because those require model/grouping correction rather than
more whitespace.

## Geometry gate

Run:

```bash
python3 scripts/visual_analyze_svg.py diagram.svg --strict --max-crossings 0
```

The analyzer checks:

- node overlap;
- edge passing through unrelated nodes;
- edge/edge crossings;
- long edge/edge overlaps (ambiguous shared corridors);
- non-orthogonal native routes;
- high-degree port congestion;
- label/node, label/label and label/edge collisions;
- extremely tight node gaps;
- suspiciously long routes;
- extreme canvas aspect ratios;
- global horizontal imbalance, sparse composition and excess bottom whitespace;
- region member containment, unrelated-node capture, header collisions and ambiguous region overlap.

Native SVG metadata can produce Blocking findings. Third-party renderer DOMs are
version-dependent, so Mermaid/Graphviz geometry is heuristic and warning-only by
default. Use `--strict-heuristic` only after verifying the renderer version.

## Crossing budgets

Default targets:

- ≤10 nodes: 0 avoidable crossings;
- 11–20 nodes: at most 2 avoidable crossings;
- >20 nodes: split the view before increasing the crossing budget unless the graph
  itself is the subject.

A budget is not permission to accept an edge through a node. Edge/node crossings are
always Blocking for native high-level architecture output.

## Repair order

When the geometry gate fails, repair in this order:

1. reorder nodes within layers;
2. move a node to the correct semantic layer if the evidence/view permits it;
3. use a side/perimeter channel for a long edge;
4. shorten labels that distort node width;
5. change direction only when the story remains natural;
6. split the view if density remains high.

Never repair readability by changing architectural meaning, reversing direction,
merging distinct evidenced nodes, or inventing a boundary.

## Acceptance invariant

For a polished high-level architecture diagram, delivery requires all three:

1. evidence spec passes;
2. geometry analyzer has no Blocking finding;
3. the final rendered image is inspected at 100% for typography, hierarchy and
   subjective balance that geometry checks cannot fully measure.

Machine checks and automatic repair reduce visual mistakes; they do not replace human/agent visual review.
Composition findings are warnings by default because asymmetric architectures can be
legitimate; region ambiguity and containment defects are Blocking for native output.
