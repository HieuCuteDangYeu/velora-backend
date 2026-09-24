# Diagram type selection

Choose from the question, not from what is easiest to render.

| Question | Type | Profile |
|---|---|---|
| enterprise/system map | C4 Landscape | architecture |
| who uses this system / external dependencies | C4 Context | architecture |
| what runs / major apps and datastores | C4 Container | architecture |
| what's inside one service/container | C4 Component | architecture |
| runtime collaboration at architecture level | C4 Dynamic | architecture |
| messages over time | Sequence | sequence |
| OO/type relationships | Class | class |
| data entities/tables/cardinality | ER | er |
| lifecycle/transitions | State | state |
| dataset transformations | Dataflow | dataflow |
| where it runs | Deployment | deployment |
| who calls this / impact radius | Call graph | callgraph |
| actors and goals | Use case | usecase |
| process/branch logic | Flowchart | flowchart |
| process + ownership/handoffs | Swimlane | flowchart |

When two fit, ask what the reader needs to reason about:
structure, time, data, lifecycle, deployment, ownership, or actor goals.

## Budgets

- C4 Context/Landscape: ~8 boxes
- C4 Container: ~12 containers
- C4 Component: ~15 components
- Sequence: ≤8 participants, ≤25 meaningful messages
- Class: ≤12 classes/types
- ER: ≤15 entities
- State: target ≤12 primary states per view
- Call graph: ≤4 levels deep
- Use case: ≤5 actors, ≤12 use cases
- Flowchart/swimlane: split when normal 100% reading requires tracing crossings twice

Over budget means zoom out/split, not shrink text.

## Discipline

One question and one abstraction level per diagram. A folder tree is not architecture.
A class diagram is optional code-level documentation and should usually be generated
on demand. Deployment detail belongs in deployment views, not container views.
