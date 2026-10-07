#!/usr/bin/env node
// Additive Mongo index only. Never resets, backfills, or drops a collection.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/conversation-client');
const index = {
  name: 'messages_notification_outbox_due',
  key: { notificationNextAttemptAt: 1, _id: 1 },
};
const client = new PrismaClient();

async function main() {
  const result = await client.$runCommandRaw({ listIndexes: 'messages' });
  const existing = result.cursor.firstBatch.find((item) => item.name === index.name);
  if (existing && JSON.stringify(existing.key) !== JSON.stringify(index.key)) {
    throw new Error('Existing outbox index has a conflicting key; inspect manually');
  }
  const apply = process.argv.includes('--apply');
  if (apply && !existing) {
    await client.$runCommandRaw({ createIndexes: 'messages', indexes: [index] });
  }
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    index: index.name,
    state: existing ? 'already present' : apply ? 'created' : 'would create',
    backfill: false,
    deletes: false,
  }));
}

main().catch((error) => {
  // Prisma errors can contain a connection URI. Do not dump them into logs.
  console.error('Outbox index failed:', error.code || 'inspect index/configuration');
  process.exitCode = 1;
}).finally(() => client.$disconnect());
