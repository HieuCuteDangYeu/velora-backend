# Call-graph profile

## Semantic contract
One root or small root set; depth ≤4 by default. Every edge has call-site/tool evidence.
Mark dynamic/partial dispatch confidence. Cycles remain visible. Framework dispatch
can stop at a boundary when exact target is unresolved.

## Presentation contract
Root visually dominant. Separate incoming/outgoing trees when showing both. Direction
is caller → callee. Collapse uninteresting utility leaves. Use one restrained accent
for cycles.

## Renderer
Graphviz dot preferred; Mermaid fallback.

## Blocking
Static edge presented as certain runtime behavior; interface target guessed; depth
explosion; cycle hidden; caller/callee reversed.
