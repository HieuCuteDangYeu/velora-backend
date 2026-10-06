# Reducing Mongo commands per chat send

## Verified on 2026-10-06

The live Prisma client is 5.22.0. Mongo has the compound unique index on
`conversationId, senderId, clientMessageId`, both history indexes, and the
Conversation participant index. No schema or index change is required.

A bounded rollback probe in an existing stress fixture showed eight Mongo
command observations for the original text-send path: two membership reads,
five commands for message creation plus preview update, and a post-commit
Conversation read. Reusing the preview update result and keeping one membership
read reduces that to six. The probe deliberately rolls back; its wall times are
not a production commit benchmark. It does not establish the Atlas tier or prove
provider throttling. Read/write command observations are not connection-pool
wait measurements.

## Initial change at 7fc66969

- Keep the existing Prisma array transaction, per-conversation queue, P2034
  retry policy, unique-key reconciliation and sender ACK deadline.
- Return the committed Conversation snapshot with a newly created message.
  Socket and HTTP delivery enrich this snapshot through User RPC after
  persistence instead of reading the Conversation again. No completed snapshot
  or authorization decision is cached across sends.
- Let the repository enforce membership before every write. Remove only the
  duplicate Socket.IO send precheck; room joins and other operations retain
  their own checks. Forbidden/missing conversations still produce
  `message_failed` with a rejected outcome, never a sender ACK or peer fanout.
- Add `velora_conversation_mongo_command_duration_seconds` with four fixed
  command labels. Prisma emits query events to the observer, never stdout.
  Query contents, parameters, tokens, and IDs are not exported. No outcome is
  inferred from query events. Retry backoff gets its own chat phase sample.

The returned snapshot represents membership/metadata at transaction time;
later group edits remain separate realtime events. It does not eliminate the
existing membership-change race between the pre-write check and transaction.

## Initial verification and retest

Tests cover one authoritative membership check, forbidden/missing rejection
before mutation, snapshot reuse after ACK, idempotent replay, transaction
serialization/retries, and bounded command observations. Run the Conversation
suite, typecheck, and lint. Then deploy and repeat the same 20-room diagnostic
workload (one sender and one observer; 8-second sender deadline). Compare
completed stages and latency, Mongo command rate/duration, queue wait, retries,
User/Auth errors, and observer delivery. Do not infer 50/s capacity from a
planned stage that did not complete.

No migration, database deletion, provider upgrade, connection-limit change,
write-concern reduction or timeout increase is part of this change.

## Follow-up: PostgreSQL budget and five-command text path

The real 20-room retest of `7fc66969` passed 5/s and 10/s, but 15/s had
26 sender timeouts and 19 unissued sends. The observer received all 1,781
issued messages. Notification separately logged 48 P2037 errors.

Read-only `pg_stat_activity` inspection identified a second Aiven instance
shared by Notification and Monitoring, distinct from the User/Auth instance.
It has max_connections=20 and three superuser-reserved slots. After load,
Notification held 13 idle connections, Monitoring two, and the management
agent one. The temporary audit client used one additional connection and
was disconnected afterwards. Background workers shown in pg_stat_activity
are not all client connections and must not be added to this pool budget.

Compose now explicitly limits Notification to four connections. Monitoring
has two separately injected Prisma clients, each limited to one connection,
so its configured total is two. This uses six app connections and leaves
headroom for managed maintenance, tools and future work. The overrides alter
only connection_limit, preserve URL SSL/pool_timeout settings, validate
positive safe integers, and do not modify .env secrets or the User/Auth pool.
Outside Compose, an absent override preserves the existing URL configuration.

The message path now uses an interactive Prisma transaction:

1. Read the full Conversation after entering the per-room queue and validate
   membership within the transaction snapshot.
2. Create the message with the existing compound unique identity.
3. Update the Conversation preview with updateMany, explicitly setting both
   preview time and updatedAt. Check count=1 inside the transaction.
4. Return the snapshot with exactly those changed fields after commit; no
   final read-back is required. A missing preview aborts and rolls back the
   message. A concurrent membership write conflicts with the preview update,
   so P2034 retries re-read membership.

Reply sends retain an initial authorization check before reading the reply
preview, and also check membership inside the write transaction. Plain text
sends use the transaction membership check alone. Room joins and other
operations keep their checks. Snapshot reuse does not cache authorization.

Four bounded rollback probes on the existing fixture observed six commands
for the prior plain-text path versus five for this path; all probes verified
message and preview rollback. A separate zero-update-count guard probe also
verified message rollback and unchanged preview. These timings are not a
production throughput claim. Prisma still performs a pre-read for updateMany;
this change does not pretend that an update is a single driver command.

Interactive transactions explicitly use Prisma's normal 2-second maxWait
and 5-second timeout, replacing the earlier array transaction. P2028/ambiguous
failures are not blindly retried. Per-room queue limits, six P2034 attempts,
unique-key reconciliation, write concern and the sender's 8-second deadline
remain intact. Membership timings now overlap mongo_write, so nested phase
p95 values must not be added. No schema/index migration or deletion is needed.

Validation covers unauthorized/missing rejection before mutation, fresh
membership after queue waiting, reply-read authorization, zero-count abort,
transaction retry/reconciliation, serialization, and both Monitoring clients'
pool override. Re-run the same Diagnostic workload after deploying and inspect
P2037/P2024/P2028, phase timings, actual emission, timely ACK and delivery.
