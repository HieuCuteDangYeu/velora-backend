# Dataflow profile

## Semantic contract
Node roles are source, transformation, store or sink. Transformations are verb-like.
Edges name the dataset/event and distinguish batch vs stream/event. Format/frequency
only when evidenced. Control calls must not masquerade as data flow. Persistent stores
are distinct from transient queues.

## Presentation contract
Default LR. Keep primary dataset path straight. Fan-out/fan-in is intentional and
centered. Stores sit near the transformation that reads/writes them. Edge style carries
batch/stream semantics; colour is secondary.

## Renderer
Mermaid + ELK preferred; Graphviz dot fallback.

## Blocking
Unlabelled dataset; control call shown as data movement; source/sink reversed;
transformation invented; main dataset lost in crossings.
