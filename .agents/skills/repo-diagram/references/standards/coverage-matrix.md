# Standards coverage matrix

A green validator means only the rows marked **Enforced subset**, not the entirety of
the referenced standard.

| Area | Source | Status | Enforced subset |
|---|---|---|---|
| UML Use Case | OMG UML 2.5.1 | Enforced subset | actor/usecase endpoints, include/extend/generalization kinds/direction, extension-point references |
| UML Sequence | OMG UML 2.5.1 | Enforced subset | MessageSort vocabulary, sync/async consistency, ordered messages, supported InteractionOperatorKind, fragment edge references |
| UML Class | OMG UML 2.5.1 | Enforced subset | classifier kinds, realization/generalization targets, acyclic inheritance, basic multiplicity grammar, normalized navigability |
| C4 | C4 Model | Enforced subset | abstraction profile, title, legend, element type, description, container/component technology, labelled relationships, network protocol |
| Architecture description | ISO/IEC/IEEE 42010:2022 | Alignment subset | entity of interest, evidenced stakeholders/concerns, viewpoint references, model kinds |
| Conceptual ER | Chen 1976 + textbook | Enforced subset | relationship nodes, weak-entity identifying relation, Chen relation vocabulary, total/partial participation vocabulary when present |
| Logical/Physical ER | Information Engineering/Crow's Foot | Enforced subset | explicit mode, canonical cardinalities, physical identifying flag |
| Rendering | Mermaid/PlantUML/Graphviz docs | Capability only | syntax/version/renderer availability; renderer docs are not modelling standards |

## Explicitly not claimed yet

### UML
Not full UML 2.5.1 metamodel conformance. Gaps include complete interaction
OccurrenceSpecification/Gate/timing constraints, association classes, n-ary
associations, qualifiers, template binding/redefinition, and diagram families the
plugin does not currently expose.

### ISO/IEC/IEEE 42010:2022
Not a full architecture-description conformance checker. The plugin checks a practical
alignment subset around entity of interest, stakeholders, concerns, viewpoint
references, and model kinds. It does not validate every conformance clause.

### ER modelling
Chen mode does not mechanically prove every participation/cardinality constraint from
prose requirements or all specialization constraints. Crow's Foot mode intentionally
normalizes to the common min/max cardinality forms.

### Textbooks
Fowler, Booch/Rumbaugh/Jacobson, Brown, Bass/Clements/Kazman,
Silberschatz/Korth/Sudarshan, and Martin guide modelling practice but do not override
normative OMG/ISO semantics.

## Claim vocabulary

Allowed:
- source-verified
- validated against Repo Diagrammer's documented OMG UML 2.5.1 subset
- C4 documented-subset checks passed
- ISO/IEC/IEEE 42010:2022 alignment subset checked
- Chen conceptual ER documented subset checked

Do not claim full UML/ISO conformance unless independently demonstrated outside this
plugin.
