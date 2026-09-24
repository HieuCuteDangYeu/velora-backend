# ER modelling standards and textbook modes

## Conceptual ER — Chen

Primary source:
Peter P. Chen, “The Entity-Relationship Model—Toward a Unified View of Data,”
ACM Transactions on Database Systems 1(1), 1976.
https://doi.org/10.1145/320434.320440

Teaching reference:
Silberschatz, Korth, Sudarshan, Database System Concepts, 7th ed., Chapter 6.
https://www.db-book.com/

Mode: conceptual-chen

IR supports:
- entity;
- weak entity;
- relationship as a first-class node;
- attribute;
- identifying relationship;
- participation;
- ISA/specialization-generalization where evidenced.

A conceptual Chen view must not silently turn relationships into relational foreign
keys. It describes conceptual semantics before relational implementation.

## Information Engineering / Crow's Foot

Modes:
- logical-crows-foot
- physical-crows-foot

Canonical normalized cardinalities:
- 0..1
- 1
- 0..*
- 1..*

Logical mode focuses on business entities, identifiers, and relationships.

Physical mode reflects implemented tables/collections, keys/constraints, association
tables, and identifying/non-identifying relationships from schema evidence.

The IR stores identifying as a Boolean in physical mode so renderers can choose
solid/dashed or their native equivalent consistently.

## Evidence priority

Physical:
live constraints > migrations > declared schema > ORM inference.

Conceptual/logical:
explicit domain/schema documentation > schema/migrations > curated inference, with
uncertainty recorded in Gaps.

Do not claim Peter Chen notation when the picture is actually a Crow's Foot physical
schema, and do not label a Crow's Foot table diagram “Chen ERD”.
