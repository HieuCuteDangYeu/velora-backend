# Diagram reviewer procedure

Review like a staff engineer. A professional-looking wrong diagram is dangerous; an
accurate unreadable diagram is unfinished.

## 1. Truth

Verify cited facts against source. Small diagrams: check all. Larger diagrams: check
all nodes plus every boundary-crossing or semantically important edge.

Report:
- CONTRADICTED — source disagrees;
- UNCITED — real canvas fact has no evidence;
- OMITTED — missing fact changes the reader's mental model.

Decoration does not need code evidence, but must not create a factual claim.

## 2. Semantic model

Read the selected profile under `profiles/`.

Check renderer-neutral semantics before appearance: direction, sync/async, order,
relationship kind, cardinality, guards, dataset meaning, deployment nesting, actor
roles, call-graph confidence, etc.

A renderer may not silently downgrade semantics.

## 3. Standards / textbook conformance

Read `conformance.mode` and `conformance.targets` from the spec.

For `textbook-strict`:
- load `standards/README.md` and the matching standard file(s);
- run `scripts/validate_spec.py`;
- treat a validator failure as Blocking CONFORMANCE;
- verify rules that are semantic but not mechanically decidable against source;
- never upgrade the claim from "documented subset" to "fully compliant".

Important examples:
- UML Use Case: include/extend direction, extension points, actor/usecase endpoints;
- UML Sequence: MessageSort and InteractionOperatorKind semantics;
- UML Class: realization/generalization/multiplicity/navigability;
- C4: title, key/legend, explicit element type, responsibility, technology, labelled relations;
- ISO 42010 alignment: entity of interest, stakeholders, concerns, viewpoint, model kinds;
- ER: Chen conceptual vs Crow's Foot logical/physical mode must not be mixed.

If standards material does not support a claim, report it rather than filling the gap
from general knowledge.

## 4. Abstraction/view

Check one question, one level, budget, real boundaries, and stable identifiers.
Presentation groups may contain evidenced nodes but cannot receive architectural edges.

For a set, verify cross-view consistency against `model.spec.yaml`.

## 5. Presentation

Inspect the rendered output at 100%, not just source.

Apply both `layout-quality.md` and the selected type profile.

Blocking VISUAL examples:
- architecture: raw auto-layout, mixed hierarchy, missing relation legend/protocol;
- sequence: async indistinguishable, participant order causes constant backtracking;
- class: hierarchy unreadable, member dump dominates;
- ER: cardinalities/keys unreadable, central model lost;
- state: happy lifecycle buried under recovery crossings;
- dataflow: datasets cannot be followed source→sink;
- deployment: topology/instance hierarchy unclear;
- callgraph: root lost or cycles obscured;
- usecase: actors/boundary/goals ambiguous;
- flowchart/swimlane: decisions or ownership handoffs unclear.

High-level architecture additionally loads `high-level-architecture-style.md`.

If no renderer is available, visual review is UNVERIFIED.

## 6. Render validity

Use `scripts/render_any.sh` for mmd/puml/dot, or `validate_mermaid.sh` for Markdown.
Missing renderer/browser is an environment limitation, not a diagram defect.

## Return exactly

```
## Verdict
<SHIP | FIX FIRST | REDRAW> — <one sentence>

## Blocking
- [<CONTRADICTED|UNCITED|OMITTED|WRONG-SEMANTICS|ABSTRACTION|CONFORMANCE|VISUAL>] ...

## Should fix
- [<READABILITY|LABEL|MAINTAINABILITY>] ...

## Optional
- ...

## Verified
- <n> of <m> elements checked; <k> relations traced.
- Type profile: <profile>
- Conformance: <practical | textbook-strict — targets — documented subset>
- Renderer: <renderer>
- Visual review: <passed | unverified — reason>
```

Do not invent findings to look thorough.
