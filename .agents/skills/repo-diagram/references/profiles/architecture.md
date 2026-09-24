# Architecture profile

Sources:
- C4 Model official notation/checklist.
- ISO/IEC/IEEE 42010:2022 when architecture-description alignment is requested.
- Simon Brown and Bass/Clements/Kazman as informative practice references.

## Semantic contract

One C4 abstraction level per static view.

- Landscape: software systems/people across an enterprise/ecosystem scope.
- Context: system of interest, people, and external software systems.
- Container: separately running applications/data stores and direct externals.
- Component: components inside one container plus immediate collaborators.
- Dynamic: one runtime story using elements from the static model.

Every relationship is unidirectional and labelled with intent. Inter-process
relationships show protocol/technology when evidenced. Real boundaries require evidence.

## C4 textbook-strict

Requires target c4-model, title, key/legend, explicit element type, short
responsibility for every element, technology for containers/components/datastores/
queues, labelled relationships, and protocols on network hops.

## ISO 42010 alignment subset

When target iso-iec-ieee-42010-2022 is selected, record entity of interest,
stakeholders, concerns, viewpoint, viewpoint references, and model kinds.

Stakeholders/concerns must come from requirements/docs/ADRs or explicit user input.
This is documented alignment, not an automatic full-conformance claim.

## Presentation contract

Context: system of interest visually dominant. Container/high-level views use the
polished-overview style when appropriate. For polished static architecture, prefer the
geometry-owned SVG renderer and require the geometry gate from `visual-compiler.md`.
Component views keep the owning container boundary obvious. External systems stay peripheral.

## Blocking

Mixed abstraction; unlabelled relation; missing protocol; false boundary; missing C4
legend/type/responsibility in strict mode; cross-view renaming; bad ISO metadata
references; static/runtime/deployment concerns crammed into one view; node overlap;
edge through unrelated node; avoidable crossings above the declared budget; region
capture of unrelated nodes; ambiguous non-nested region overlap.
