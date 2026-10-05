# Message identity index maintenance

The Message schema declares uniqueness on `(conversationId, senderId,
clientMessageId)`. A deployment can still be missing the database index. In that
case, a replay can create a new stored message even when the application handles
Prisma P2002 correctly.

Use `scripts/ops/repair-message-identity-index.cjs` to audit the live collection.
It uses the generated Conversation Prisma client and the existing
`CONVERSATION_DATABASE_URL` environment variable. The default mode is read-only:

```sh
node scripts/ops/repair-message-identity-index.cjs
node --test scripts/ops/repair-message-identity-index.test.cjs
```

## Preserve historical messages

The repair keeps the oldest message in each duplicate identity group, ordered by
`createdAt` then `_id`, under the original client identity. Extra messages receive
`legacy-duplicate:<message _id>`. No message is deleted or merged. Their `_id`,
content, timestamps, media, metadata, reactions, read state and reply references
remain unchanged. A replay under the original identity resolves to the oldest
record; cached client identities may need reconciliation.

The tool refuses invalid/missing identity fields, truncated audit results,
replacement-key collisions, a different approved rekey count and an existing
backup filename. Resolve those conditions separately; do not use `db push
--accept-data-loss` as a substitute.

## Apply in a short maintenance window

1. Review the audit summary and approve changing identity metadata on the exact
   duplicate records. Keep backup data private; it contains original documents.
2. Stop every Conversation Service writer gracefully. Verify that no other
   process writes to `messages`. Run the repair from a separate process/container
   with the generated client and database environment available. Always restore
   the writers in a `finally`/shell trap, including when the repair fails.
3. Provide an absolute backup path in a directory with permissions `0700`, and
   the expected rekey count from the reviewed audit. The example count below is
   specific to the 2026-10-05 audit; future audits may differ.

```sh
CONFIRM=REKEY_DUPLICATE_MESSAGE_IDENTITIES \
MESSAGE_WRITERS_PAUSED=true \
node scripts/ops/repair-message-identity-index.cjs \
  --apply --expected-rekeys 16 --backup /private/maintenance/originals.json
```

The tool writes and fsyncs a new backup with permissions `0600`, updates only
`clientMessageId` with compare-and-set identity conditions, checks every other
field against a hash taken before the update, and verifies the total row count.
It then creates only the full compound unique index
`messages_conversationId_senderId_clientMessageId_key` and verifies it. It does
not drop collections/indexes or create a partial/sparse substitute.

4. Restore the writers. Invalidate `chat:history:<conversationId>` Redis cache
   keys for affected conversations using the same Redis configuration as the
   service. Do not clear the entire Redis database.
5. Repeat the audit, then run the dashboard retry probe and a modest chat load
   test. A replay must return the same stored ID; observer delivery should not
   repeat. Check application errors and queue/latency behavior separately.

## Recovery and limits

On a partial or failed repair, retain the private backup and inspect which
guarded updates succeeded before retrying. Restoring duplicate identities would
conflict with the new unique index; plan a separate maintenance window and
account for intervening writes before any index rollback. Never delete messages
as an automatic recovery step.

This enforces one persisted message per identity. It does not make socket/push
delivery exactly once or close the post-commit dispatch crash gap. The
per-conversation transaction queue is per process; the database unique index
enforces identity across replicas.
