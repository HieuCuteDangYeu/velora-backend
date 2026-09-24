# ER profile

Sources:
- Peter Chen 1976 for conceptual ER.
- Database System Concepts for textbook entities, relationships, cardinality,
  participation, weak entities, and generalization.
- Information Engineering / Crow's Foot for practical logical/physical notation.

## Required strict mode

Choose exactly one:
- conceptual-chen
- logical-crows-foot
- physical-crows-foot

Do not mix them silently.

## conceptual-chen

Use entity, weak-entity, relationship, and attribute as first-class semantic elements.
A relationship is a relationship node in the IR, enabling binary or n-ary conceptual
relationships.

Supported relation semantics:
- participates
- identifies
- has-attribute
- isa

Weak entities require identifying-relationship evidence. Conceptual mode must not
invent relational foreign keys.

## logical-crows-foot

Model business entities/identifiers/relationships with canonical cardinalities:
0..1, 1, 0..*, 1..*.

## physical-crows-foot

Reflect implemented tables/entities and constraints. Evidence priority:
live constraints → migrations → declared schema → ORM inference.

Join/association tables remain visible. identifying=true/false is explicit.

## Presentation contract

Cardinality must be readable at 100%. Show only attributes needed for identity,
relationships, and business meaning unless a full physical schema was requested.
≤15 entities per view by default.

## Blocking

Mode missing/mixed; guessed cardinality; reversed relation/FK; invalid Crow's Foot
cardinality; constraints ignored; Chen conceptual rendered as FK-only relational
schema; weak entity without identifying semantics; every column dumped into a
high-level ERD.
