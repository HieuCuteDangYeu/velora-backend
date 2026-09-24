# Spec field guide

The YAML spec is a renderer-neutral evidence and semantics model.

## Conformance

```yaml
conformance:
  mode: practical              # or textbook-strict
  targets: []                  # selected standards/models only
  claim: documented-subset
```

Supported strict targets:
- omg-uml-2.5.1
- c4-model
- iso-iec-ieee-42010-2022
- chen-1976
- ie-crows-foot

The validator intentionally rejects claims stronger than `documented-subset`.

## Common node fields

`id, label, display_label, kind, tech, responsibility, stereotype, semantic_role,
members, attributes, extension_points, confidence, evidence`.

## Common relation fields

`id, from, to, relation, label, protocol, sync, crosses_network, order, message_sort,
condition, guard, action, extension_points, cardinality_from, cardinality_to,
role_from, role_to, navigability, identifying, data, frequency, confidence, evidence`.

Use only fields relevant to the selected type.

Examples of relation:
- architecture: calls, routes-to, publishes, consumes, reads, writes;
- class: extends, implements, composes, aggregates, associates, depends-on;
- Chen ER: participates, identifies, has-attribute, isa;
- state: transitions;
- use case: associates, includes, extends, generalizes;
- deployment: hosts, routes-to, connects-to;
- dataflow: flows.

## UML interaction fragments

`interaction_fragments` references message edge IDs and uses UML operator vocabulary:
alt, opt, loop, break, par, seq, strict, critical, neg, assert, ignore, consider.

## ER mode

`view.options.er_mode` is mandatory in textbook-strict ER:
- conceptual-chen
- logical-crows-foot
- physical-crows-foot

## Architecture-description alignment

When `iso-iec-ieee-42010-2022` is a target, `architecture_description` records:
entity of interest, stakeholders, concerns, and a viewpoint with stakeholder/concern
references plus model kinds.

Stakeholder/concern evidence should come from requirements, documentation, ADRs, or
explicit user-provided project information, not inference from code.

Presentation metadata controls appearance only and cannot add facts.


## Conceptual ER participation

For `conceptual-chen`, a participation edge may record
`participation: total|partial` when source evidence supports that constraint. Do not
invent participation merely to complete the notation.
