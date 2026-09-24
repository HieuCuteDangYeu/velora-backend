# Sequence profile

Sources:
- OMG UML 2.5.1 Interactions for message/fragment semantics.
- Fowler and UML User Guide for practical usage.

## Semantic contract

One named runtime scenario per diagram. Start from a real entrypoint and trace
execution order.

Practical mode:
- real participants;
- sync vs async distinction;
- broker/queue shown when it creates the async boundary;
- alt/opt/loop/par/break only when code supports them;
- returns only when useful.

Textbook-strict additionally models UML MessageSort:
synchCall, asynchCall, asynchSignal, createMessage, deleteMessage, reply.

Supported UML InteractionOperatorKind:
alt, opt, loop, break, par, seq, strict, critical, neg, assert, ignore, consider.

Each fragment references real message-edge IDs. Guards and operands must come from
source behavior.

## Presentation contract

Caller/actor left; downstream systems progress right. ≤8 participants and ≤25
meaningful messages by default. Labels are actions, not DTO dumps. Use phase dividers
for longer scenarios. Split recovery/error scenarios when they obscure the normal path.

## Renderer

Mermaid for simple interactions. PlantUML for multiple nested fragments, richer
activation/lifecycle notation, or UML-heavy review.

## Blocking

Invented message; async drawn as blocking; required broker omitted; wrong MessageSort;
unsupported fragment operator; branch without evidence; constant participant
backtracking; several scenarios collapsed into one timeline.
