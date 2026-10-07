# Recoverable new-message notification intake

Previously Conversation started an HTTP request after saving a message and
swallowed failures. A Notification queue-full response could lose that message's
push intent even though chat persistence and socket delivery succeeded.

## Contract

- Public Socket.IO and API sends use `SendMessageUseCase`. Its existing Mongo
  transaction writes the encrypted message, preview and recipient snapshot in
  one commit. No separate insert or post-commit enqueue is needed.
- Bot/system producers do not opt in. Historical messages have no due date and
  are never backfilled. Replays use the existing compound message identity; they
  neither create another intent nor reset a pending one.
- One worker per instance polls a maximum of 20 candidates each second, with two
  concurrent requests. Atomic claims hold a 30-second lease. A UUID fences both
  completion and retry so an expired worker cannot clear a newer claim.
- Only HTTP 202 with a valid `queued` receipt completes an intent. Notification
  persists jobs before returning that receipt. Its existing per-recipient dedupe
  key makes ambiguous timeout/restart replays safe, including `createdCount: 0`.
- HTTP requests have a five-second deadline. Failures use exponential backoff
  with jitter, capped below five minutes. There is no silent retry exhaustion.
  Missing credentials or incompatible receivers remain pending for operators.
- Before delivery, the worker excludes recalled messages and recipients who are
  no longer current members. It never adds newly joined members to old intents.
  Normal content is decrypted in memory; the outbox stores no extra plaintext.

This guarantees recoverable **notification job intake**, conditional on Mongo
and Notification eventually being available. It does not make device delivery
exactly once, make socket fanout durable, or guarantee ordering across messages.
Recall/membership can still race an already accepted job. Existing Notification
retention/dedupe policy must keep job identities while outbox retries are possible.

## Connection budget and monitoring

The worker reuses Conversation's Mongo Prisma client. Notification's four-worker,
four-connection PostgreSQL budget remains unchanged, as do Monitoring's two
connections. No PostgreSQL client or pool setting is added here.

- `velora_conversation_notification_outbox_pending`: persisted pending intents,
  including leases/backoff; sampled after a batch at most every ten seconds.
- `velora_conversation_notification_outbox_total{outcome="queued|retry|cancelled|lease_lost|poll_error"}`:
  bounded outcome counters. `queued` confirms durable intake, not mobile receipt.
- The existing `notification` phase duration now measures background intake.
  It is outside the synchronous send handler and should be read separately.

Concurrency is per process. Multiple Conversation replicas multiply intake
concurrency; claims and fencing still prevent ordinary duplicate processing.

## Additive rollout

Optional scalar fields and an embedded recipient list require no data rewrite.
Create only the due-date index before deploying the generated client:

```sh
node apps/conversation-service/prisma/notification-outbox-index.cjs
node apps/conversation-service/prisma/notification-outbox-index.cjs --apply
```

The first command is read-only; the second adds one index if absent. Neither
resets data, changes encryption keys, drops indexes, nor backfills notifications.
Do not use `prisma db push --accept-data-loss` or `prisma migrate reset`.

The deployment script intentionally gates changes under `prisma/`. After
verifying this additive index, record approval for the exact release SHA using
`velora-deploy --approve-db-change <SHA>`, then resume that release. Rolling back
to the old sender stops draining the outbox; queued intents are retained and
resume when the new worker is restored. Keep Notification's durable batch intake
version deployed before this Conversation release.

## Verification

Tests cover recipient snapshots, no opt-in for internal producers, public
entry points, HTTP receipt validation/timeouts, retry, restart recovery,
two-instance claiming, lease takeover fencing, recall/membership changes,
nonoverlapping batches and shutdown. For a live smoke test, use fixture rooms
without real push recipients, compare stored messages to durable jobs, and wait
for pending intents to drain. Do not replay historical production messages.
