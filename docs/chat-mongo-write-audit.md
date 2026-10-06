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

## Change

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

## Verification and retest

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
