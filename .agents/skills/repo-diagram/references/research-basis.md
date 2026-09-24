# Research basis

Repo Diagrammer separates normative standards, canonical industry models, academic
origins, practical textbooks, and renderer documentation.

## Normative

- OMG UML 2.5.1:
  https://www.omg.org/spec/UML/2.5.1/
- ISO/IEC/IEEE 42010:2022:
  https://www.iso.org/standard/74393.html
  https://standards.ieee.org/ieee/42010/6846/

## Canonical architecture model

- C4 model:
  https://c4model.com/
- C4 notation:
  https://c4model.com/diagrams/notation
- C4 review checklist:
  https://c4model.com/diagrams/checklist
- Structurizr model/views:
  https://docs.structurizr.com/

## Academic and textbook

- Peter P. Chen (1976), The Entity-Relationship Model—Toward a Unified View of Data,
  ACM TODS 1(1), DOI 10.1145/320434.320440.
- Silberschatz, Korth, Sudarshan, Database System Concepts, 7th ed.
  https://www.db-book.com/
- Martin Fowler, UML Distilled, 3rd ed.
  https://martinfowler.com/books/uml.html
- Grady Booch, James Rumbaugh, Ivar Jacobson,
  The Unified Modeling Language User Guide, 2nd ed.
- Simon Brown, Software Architecture for Developers.
- Len Bass, Paul Clements, Rick Kazman, Software Architecture in Practice, 4th ed.
  https://www.sei.cmu.edu/library/software-architecture-in-practice-fourth-edition/
- James Martin / Information Engineering as the practical lineage for Crow's Foot ER.

## Renderer documentation

- Mermaid syntax/layouts:
  https://mermaid.js.org/intro/syntax-reference.html
  https://mermaid.js.org/config/layouts
- PlantUML:
  https://plantuml.com/
- Graphviz dot/attributes:
  https://graphviz.org/docs/layouts/dot/
  https://graphviz.org/doc/info/attrs.html

Renderer docs define encoding capabilities, not modelling truth.

## Precedence

1. Repository evidence for what the target system actually contains.
2. Selected normative/model semantics for what the diagram means.
3. Academic/textbook guidance for practical modelling choices.
4. Renderer syntax for how the semantics are encoded visually.

See `standards/` for the exact documented subset enforced by textbook-strict mode.
