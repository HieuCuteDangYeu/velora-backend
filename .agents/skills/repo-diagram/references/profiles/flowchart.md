# Flowchart and swimlane profile

## Semantic contract
Explicit start/end for bounded processes. Action nodes use verb phrases. Decisions map
to real predicates and outgoing edges carry understandable conditions. Loops map to
real retry/repetition. Swimlane lanes use exactly one ownership dimension (actor,
team, or system); decisions sit with the owner; important cross-lane handoffs are
labelled.

## Presentation contract
Happy path visually straight; exceptional branches leave it cleanly. Avoid unlabeled
diamond chains. Split long processes instead of shrinking text. Use sequence/state
instead when the real question is messages/lifecycle.

## Renderer
Mermaid flowchart + ELK. Native Mermaid swimlane only when >=11.16; otherwise
flowchart lanes or PlantUML activity.

## Blocking
Invented branch; decision outcomes unlabeled; inconsistent lane ownership; state
machine disguised as process; ownership handoff hidden.
