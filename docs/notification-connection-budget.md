# Notification throughput with a fixed connection budget

The Aiven instance shared by Notification and Monitoring has 20 connections,
including three superuser-reserved slots. Compose keeps Notification at four
connections and Monitoring at two (two Prisma clients, one each). No pool
increase, schema change, migration or database deletion is required.

## What the stress test exposed

At `912b79ea`, 20-room chat passed 5/10/15 sends per second, but Notification
still logged Prisma P2024 pool wait timeouts. Its HTTP new-message handler
created and immediately processed every job. RabbitMQ prefetch does not bound
this independent HTTP path. A pool cap protects database slots but cannot
control the number of workflows contending for those slots.

## Intake and delivery

- New-message HTTP now persists a recipient batch with `createMany` and returns
  **202 queued after commit**, rather than waiting for provider delivery. Each
  job has a stable conversation/message/recipient identity using the existing
  unique idempotency-key column. Replays skip existing rows without resetting
  sent/processing/retry state. The batch is atomic, including multiple recipients.
- The existing scheduler finds durable pending/retry jobs and uses at most four
  workers in its non-overlapping poll. It drains at most five batches of 20 per
  poll, yielding on a partial or failed batch. Provider failures, expiry and
  processing leases retain their existing policies. Call event delivery remains
  on its immediate path; it is not deferred to the chat poll.
- Prisma middleware bounds all Notification database operations before they
  enter the pool: at most four, or a smaller configured URL connection limit.
  FIFO waiting consumes no DB connection. The waiting queue is bounded at 256;
  overflow rejects with a service-unavailable error rather than false acceptance.
  This gate introduces no new client or connection pool. Push-token operations
  and immediate call jobs use the same gate.
- Atomic job claim uses one parameterized SQL UPDATE RETURNING, preserving
  pending/due-failed/stale-processing eligibility, attempt
  increments and the five-minute lease. There is no separate claim read-back.
  Only claimed jobs may be delivered.

Notification currently has no explicit callback/array Prisma transactions.
Review the middleware gate before adding one: holding an outer transaction
slot while waiting for an inner operation could deadlock.

## Limits to report honestly

202 queued means durable intake, not provider acceptance or visible native UI.
The Conversation `notification` phase now measures HTTP intake; its earlier
values included processing, so they are not equivalent delivery benchmarks.
Measure job backlog/drain and provider outcomes separately during retests.

The HTTP handoff from Conversation still has no durable sender outbox. A crash
before intake or an unsuccessful HTTP request can leave a saved chat without
a push job; idempotent intake does not close that gap. A full queue returns an
error, not a success. No guarantee of exactly-once provider delivery is made.

The gate/budget apply per replica. Replicas must share the same instance-wide
connection budget; adding replicas must not multiply the four-connection pool.

## Reducing database round trips

Conversation now assigns a standard ObjectId and initial Message fields before
`createMany` inserts one record, avoiding `create`'s message read-back. Fresh
membership authorization, message insert and preview update still share the
queued transaction. Retries keep the same ObjectId/client identity; count must
be one and a unique conflict still reconciles the original stored message.
When the Message schema changes, keep the initial snapshot/defaults in sync.
Command metrics classify both insertOne and insertMany as message_insert.

Notification uses four bounded workers to overlap provider I/O without adding
database connections. Its shared gate still caps database operations at four
or the smaller configured pool. Measure backlog drain separately from intake;
four workers do not establish a sustained push capacity by themselves.
