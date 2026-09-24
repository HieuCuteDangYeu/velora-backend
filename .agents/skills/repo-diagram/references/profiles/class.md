# Class profile

Sources:
- OMG UML 2.5.1 for Classifier, Generalization, Realization, Association, Property,
  and MultiplicityElement semantics.
- Fowler/UML User Guide for practical selection.

## Semantic contract

Show only classes/interfaces/enums relevant to the question.

Relation subset:
- extends (generalization)
- implements (realization)
- composes (composite aggregation)
- aggregates (shared aggregation)
- associates
- depends-on

Textbook-strict:
- target omg-uml-2.5.1;
- realization target is an interface;
- interface generalization targets an interface;
- generalization is acyclic;
- multiplicity, when shown, follows UML bounds such as 1, *, 0..1, 1..*, 2..5;
- navigability uses normalized IR vocabulary and must not be invented;
- composition/aggregation require ownership/lifecycle evidence.

Members are curated. Generated/framework types are hidden unless relevant.

## Presentation contract

Generalization reads top-down. Interfaces stay near implementations. Dependency lines
are secondary to generalization/composition. Keep boxes comparable in density.
≤12 classifiers by default.

## Renderer

PlantUML preferred; Mermaid classDiagram fallback.

## Blocking

Wrong relation kind; realization to non-interface; cyclic generalization; invalid
multiplicity; guessed composition/aggregation; exhaustive member dump; false package
boundary.
