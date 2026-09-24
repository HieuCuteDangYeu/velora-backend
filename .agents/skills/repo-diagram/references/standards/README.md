# Standards and textbook basis

Repo Diagrammer distinguishes three source classes.

## Normative standards

- OMG UML 2.5.1 — formal semantics, metamodel, and notation for UML.
  https://www.omg.org/spec/UML/2.5.1/
- ISO/IEC/IEEE 42010:2022 — requirements for architecture descriptions,
  viewpoints, views, and model kinds.
  https://www.iso.org/standard/74393.html

## Canonical industry model

- C4 Model — canonical source for C4 abstractions, notation guidance, and
  review checklist.
  https://c4model.com/
  https://c4model.com/diagrams/notation
  https://c4model.com/diagrams/checklist

## Academic and textbook basis

- Peter P. Chen, “The Entity-Relationship Model—Toward a Unified View of Data,”
  ACM TODS 1(1), 1976, DOI 10.1145/320434.320440.
- Silberschatz, Korth, Sudarshan, Database System Concepts, 7th ed.; Chapter 6
  covers E-R database design.
- Martin Fowler, UML Distilled, 3rd ed. — practical UML subset and usage.
- Booch, Rumbaugh, Jacobson, The Unified Modeling Language User Guide, 2nd ed.
- UML-Diagrams.org — informative visual/index reference for UML 2.x notation;
  never treated as more authoritative than the OMG specification.
  https://www.uml-diagrams.org/
- Simon Brown, Software Architecture for Developers — C4 practice.
- Bass, Clements, Kazman, Software Architecture in Practice, 4th ed.
- James Martin / Information Engineering notation is treated as the de-facto
  basis for Crow’s Foot-style logical/physical ER views.

## Conformance language

Repo Diagrammer never auto-claims full conformance to UML or ISO 42010.

- practical: senior-engineering subset; source-traceable and presentation-reviewed.
- textbook-strict: mechanically enforces the documented subset in this directory.
- machine-readable claim value: `claim: documented-subset`.

Delivery wording must be “validated against the Repo Diagrammer documented subset of
<standard>” rather than “fully compliant with <standard>”.


See `coverage-matrix.md` before making a standards claim. It records what the plugin
actually enforces and what remains outside the documented subset.
