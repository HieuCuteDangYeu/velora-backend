# Evidence IR and view model

Repo Diagrammer separates **repository facts** from **diagram views**.

```text
repository → evidence facts → semantic model → view → type profile → renderer → review
```

A Mermaid/PlantUML/DOT file is a view, never the source of truth.

## Fact rules

Every real element/relation has a stable id, semantics, confidence and evidence.

Confidence:
- `direct`: source/config explicitly proves it.
- `extracted`: deterministic tool produced it.
- `resolved`: manually traced through DI/event/runtime wiring with concrete endpoints.
- `partial`: dynamic dispatch prevents complete static certainty; expose the gap.

No evidence means the fact belongs in `gaps`, not in the model.

## Common model

Nodes may describe people, systems, containers, components, classes, interfaces,
entities/tables, queues, states, transforms, deployment/infrastructure nodes or use cases.

Relations use renderer-neutral semantics such as:
`calls`, `routes-to`, `publishes`, `consumes`, `reads`, `writes`,
`extends`, `implements`, `composes`, `aggregates`, `references`,
`transitions`, `includes`, `generalizes`, `hosts`, `flows`.

Optional relation metadata carries the facts a view may need:
- order for sequence/dynamic;
- condition for branches;
- guard/action for state transitions;
- cardinality for ER;
- dataset/frequency for dataflow;
- protocol/sync/network boundary for runtime architecture;
- confidence for dynamic call-graph edges.

## Views do not rewrite facts

A view may select, suppress or visually group facts. It may not:
- invent a node/relation;
- reverse direction for prettier layout;
- change relation semantics;
- turn a presentation group into a real dependency target;
- rename a canonical code identifier differently in another view.

Abstraction is a **view** concern. The model may contain classes, services, containers
and deployment nodes simultaneously; one diagram must select one coherent level.

## One model, many views

For one diagram, a single `<slug>.spec.yaml` may hold both facts and view metadata.

For a set:

```text
docs/diagrams/model.spec.yaml
docs/diagrams/context.spec.yaml
docs/diagrams/container.spec.yaml
docs/diagrams/core-flow.sequence.spec.yaml
...
```

All view specs reuse stable model IDs. Before delivery, cross-check:
- same ID → same label/kind;
- same relation ID → same direction/semantics;
- same real boundary → same name/scope.

This prevents cross-diagram drift.
