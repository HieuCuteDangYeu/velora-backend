# OMG UML 2.5.1 — documented subset

Normative source: https://www.omg.org/spec/UML/2.5.1/

Repo Diagrammer does not attempt to implement the complete UML metamodel. In
textbook-strict mode it validates the following subset because these are the UML views
the plugin currently exposes.

## Use Case

Supported semantic elements:
- Actor
- UseCase
- subject/system boundary
- association
- Include
- Extend
- generalization
- extension point references

Rules:
- actor is external to the subject;
- association connects actor and use case;
- Include is directed from including use case to included use case;
- Extend is directed from extending use case to extended/base use case;
- Extend references one or more extension points of the extended use case in the IR;
- generalization connects same-kind actors or same-kind use cases;
- labels describe goals, not routes/classes.

## Sequence / Interaction

Supported MessageSort values:
- synchCall
- asynchCall
- asynchSignal
- createMessage
- deleteMessage
- reply

Supported InteractionOperatorKind values:
- alt, opt, loop, break, par, seq, strict, critical, neg, assert, ignore, consider

Rules:
- message edges carry unique integer order;
- sync/asynchronous flags agree with synchCall/asynchCall/asynchSignal;
- combined fragments reference actual message edges;
- guards and fragment semantics are evidence-backed;
- queue/event boundaries must not be rendered as blocking calls.

Not yet claimed:
- complete OccurrenceSpecification constraints;
- Gates or lost/found messages as first-class IR elements;
- every timing/execution constraint in the UML metamodel.

## Class

Supported classifier kinds:
- class
- abstract-class
- interface
- enum

Supported relation subset:
- generalization
- realization
- composition
- shared aggregation
- association
- dependency

Rules:
- realization target is an interface;
- interface generalization targets an interface;
- generalization cycles are rejected;
- multiplicity strings, when present, use UML-style bounds such as 1, *, 0..1,
  1..*, or 2..5;
- navigability uses normalized IR vocabulary;
- composition and aggregation require ownership/lifecycle evidence.

Not yet claimed:
- association classes;
- n-ary associations;
- qualifiers;
- template binding;
- every Property constraint or redefinition rule.

Renderer syntax never overrides OMG semantics.
