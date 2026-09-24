# Architecture standards — C4 + ISO/IEC/IEEE 42010:2022

## C4 Model

Canonical sources:
- https://c4model.com/
- https://c4model.com/diagrams/notation
- https://c4model.com/diagrams/checklist

Textbook-strict C4 checks:
- one C4 abstraction level per static view;
- title names diagram type and scope;
- key/legend is present;
- every element has explicit type, name, and short responsibility;
- container/component elements identify technology;
- every relationship is unidirectional and labelled with intent;
- inter-process relationships identify protocol/technology when known;
- names and boundaries remain stable across a diagram set.

C4 is notation independent. Renderer choice must not change C4 semantics.

C4 Code diagrams are intentionally delegated to focused code views such as class or
ER diagrams rather than pretending there is one universal code-level notation.

## ISO/IEC/IEEE 42010:2022

Official source:
https://www.iso.org/standard/74393.html

The standard distinguishes architecture from the work product describing it and
defines concepts including stakeholder, concern, architecture viewpoint, architecture
view, model kind, and architecture model.

Repo Diagrammer provides an alignment subset when
iso-iec-ieee-42010-2022 is explicitly selected.

Required textbook-strict metadata:
- entity_of_interest;
- at least one stakeholder with evidence;
- at least one concern with evidence;
- a named viewpoint;
- viewpoint references to known stakeholders and concerns;
- one or more model kinds.

Do not infer stakeholders or concerns from code alone. Evidence can be repository
requirements/docs/ADRs or explicit user-provided project requirements.

This is documented alignment, not a claim that the generated artifact satisfies every
conformance clause of ISO/IEC/IEEE 42010:2022.
