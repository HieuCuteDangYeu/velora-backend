# Use-case profile

Sources:
- OMG UML 2.5.1 for formal semantics.
- Fowler and Booch/Rumbaugh/Jacobson for practical modelling guidance.

## Semantic contract

Actors are external roles/people/systems, not internal classes. Use cases are goals,
not routes or controller methods. Keep a real subject/system boundary.

Practical mode supports association, include, extend, and generalization.

Textbook-strict additionally requires:
- target omg-uml-2.5.1;
- association connects actor and usecase;
- include means including usecase → included usecase;
- extend means extending usecase → extended/base usecase;
- extend records extension point(s) in the IR and those points exist on the base;
- generalization connects actor→actor or usecase→usecase;
- intent is evidence-backed from requirements/docs/roles, not guessed from route names.

## Presentation contract

Actors stay outside the subject boundary. Primary actors are normally left; supporting
actors can sit right. Use cases are short verb-first goals. Keep ≤5 actors and ≤12 use
cases by default.

## Renderer

Mermaid native use-case when Mermaid >=12; PlantUML otherwise. Generic flowchart is a
last-resort fallback and must be labelled as use-case-like.

## Blocking

Internal service as actor; endpoint label as goal; include/extend direction wrong;
unknown extension point; unsupported actor permission; subject boundary missing;
generalization between incompatible kinds.
