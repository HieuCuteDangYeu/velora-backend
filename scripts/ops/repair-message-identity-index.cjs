'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const INDEX_NAME = 'messages_conversationId_senderId_clientMessageId_key';
const INDEX_KEY = { conversationId: 1, senderId: 1, clientMessageId: 1 };
const CONFIRM_TOKEN = 'REKEY_DUPLICATE_MESSAGE_IDENTITIES';

function completeBatch(result) {
  const cursor = result.cursor;
  if (!cursor || String(cursor.id?.$numberLong ?? cursor.id) !== '0') {
    throw new Error('Audit exceeded one batch; refusing a truncated plan');
  }
  return cursor.firstBatch;
}

function makePlan(groups) {
  const changes = [];
  for (const group of groups) {
    for (const id of group.ids.slice(1)) {
      if (!/^[a-f0-9]{24}$/.test(id?.$oid ?? '')) {
        throw new Error('Unexpected message ID type');
      }
      changes.push({
        id,
        conversationId: group._id.conversationId,
        senderId: group._id.senderId,
        previous: group._id.clientMessageId,
        replacement: `legacy-duplicate:${id.$oid}`,
      });
    }
  }
  return changes.sort((a, b) => a.id.$oid.localeCompare(b.id.$oid));
}

function hasUniqueIndex(indexes) {
  return indexes.some(
    (index) =>
      index.unique === true &&
      !index.partialFilterExpression &&
      !index.sparse &&
      JSON.stringify(index.key) === JSON.stringify(INDEX_KEY),
  );
}

// This hashes every other field so verification detects an unintended change
// to content, _id, timestamps, reactions, media, or reply references.
function unchangedFieldsHash(document) {
  const { clientMessageId: _ignored, ...rest } = document;
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(rest)))
    .digest('hex');
}

async function audit(prisma) {
  const count = await prisma.$runCommandRaw({ count: 'messages', query: {} });
  const invalid = await prisma.$runCommandRaw({
    count: 'messages',
    query: {
      $or: [
        { clientMessageId: { $not: { $type: 'string' } } },
        { clientMessageId: '' },
        { conversationId: { $not: { $type: 'objectId' } } },
        { senderId: { $not: { $type: 'string' } } },
        { senderId: '' },
      ],
    },
  });
  if (invalid.n !== 0) {
    throw new Error(
      `Found ${invalid.n} invalid/legacy identities; resolve separately`,
    );
  }
  const groups = completeBatch(
    await prisma.$runCommandRaw({
      aggregate: 'messages',
      pipeline: [
        { $sort: { createdAt: 1, _id: 1 } },
        {
          $group: {
            _id: {
              conversationId: '$conversationId',
              senderId: '$senderId',
              clientMessageId: '$clientMessageId',
            },
            count: { $sum: 1 },
            ids: { $push: '$_id' },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ],
      cursor: { batchSize: 1000 },
      maxTimeMS: 60000,
      allowDiskUse: true,
    }),
  );
  const indexes = completeBatch(
    await prisma.$runCommandRaw({
      listIndexes: 'messages',
      cursor: { batchSize: 1000 },
    }),
  );
  const changes = makePlan(groups);
  if (changes.length) {
    const collisions = await prisma.$runCommandRaw({
      count: 'messages',
      query: {
        clientMessageId: { $in: changes.map((item) => item.replacement) },
      },
    });
    if (collisions.n !== 0)
      throw new Error('Replacement identity already exists');
  }
  return {
    totalMessages: count.n,
    duplicateGroups: groups.length,
    changes,
    indexes,
  };
}

function guardedUpdate(item) {
  return {
    q: {
      _id: item.id,
      conversationId: item.conversationId,
      senderId: item.senderId,
      clientMessageId: item.previous,
    },
    u: { $set: { clientMessageId: item.replacement } },
    multi: false,
    upsert: false,
  };
}

async function apply(prisma, before, options) {
  if (options.confirm !== CONFIRM_TOKEN || options.writersPaused !== true) {
    throw new Error(
      'Explicit confirmation and paused message writers are required',
    );
  }
  if (options.expectedRekeys !== before.changes.length) {
    throw new Error('Rekey count differs from the approved count');
  }
  if (!path.isAbsolute(options.backupPath ?? '')) {
    throw new Error('An absolute private backup path is required');
  }
  if (hasUniqueIndex(before.indexes) && before.changes.length === 0) {
    return {
      alreadyProtected: true,
      totalMessages: before.totalMessages,
      rekeyed: 0,
    };
  }
  const originals = before.changes.length
    ? completeBatch(
        await prisma.$runCommandRaw({
          find: 'messages',
          filter: { _id: { $in: before.changes.map((item) => item.id) } },
          batchSize: 1000,
        }),
      )
    : [];
  if (originals.length !== before.changes.length)
    throw new Error('Backup row count mismatch');
  const originalHashes = new Map(
    originals.map((doc) => [doc._id.$oid, unchangedFieldsHash(doc)]),
  );
  const backup = JSON.stringify(
    { createdAt: new Date().toISOString(), ...before, originals },
    null,
    2,
  );
  // Exclusive creation prevents overwriting a previous backup on a rerun.
  const fd = fs.openSync(options.backupPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, backup);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (before.changes.length) {
    const result = await prisma.$runCommandRaw({
      update: 'messages',
      updates: before.changes.map(guardedUpdate),
      ordered: true,
      writeConcern: { w: 'majority' },
    });
    if (
      result.writeErrors?.length ||
      result.writeConcernError ||
      result.nModified !== before.changes.length
    ) {
      throw new Error(
        'Rekey was not fully confirmed; inspect the private backup before proceeding',
      );
    }
    const after = completeBatch(
      await prisma.$runCommandRaw({
        find: 'messages',
        filter: { _id: { $in: before.changes.map((item) => item.id) } },
        batchSize: 1000,
      }),
    );
    const expectedById = new Map(
      before.changes.map((item) => [item.id.$oid, item.replacement]),
    );
    if (
      after.length !== originals.length ||
      after.some(
        (doc) =>
          doc.clientMessageId !== expectedById.get(doc._id.$oid) ||
          unchangedFieldsHash(doc) !== originalHashes.get(doc._id.$oid),
      )
    ) {
      throw new Error('Document preservation verification failed');
    }
  }
  const clean = await audit(prisma);
  if (clean.changes.length || clean.totalMessages !== before.totalMessages) {
    throw new Error('Post-rekey audit failed; refusing index creation');
  }
  await prisma.$runCommandRaw({
    createIndexes: 'messages',
    indexes: [{ key: INDEX_KEY, name: INDEX_NAME, unique: true }],
    writeConcern: { w: 'majority' },
  });
  const verified = await audit(prisma);
  if (
    !hasUniqueIndex(verified.indexes) ||
    verified.totalMessages !== before.totalMessages ||
    verified.changes.length
  ) {
    throw new Error('Index verification failed');
  }
  return {
    totalMessages: verified.totalMessages,
    rekeyed: before.changes.length,
    uniqueIndex: true,
    otherFieldsPreserved: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const applying = args.includes('--apply');
  const option = (name) => args[args.indexOf(name) + 1];
  const { PrismaClient } = require('@prisma/conversation-client');
  const prisma = new PrismaClient();
  try {
    const before = await audit(prisma);
    if (!applying) {
      console.log(
        JSON.stringify({
          mode: 'audit',
          totalMessages: before.totalMessages,
          duplicateGroups: before.duplicateGroups,
          proposedRekeys: before.changes.length,
          uniqueIndex: hasUniqueIndex(before.indexes),
        }),
      );
      return;
    }
    const result = await apply(prisma, before, {
      confirm: process.env.CONFIRM,
      writersPaused: process.env.MESSAGE_WRITERS_PAUSED === 'true',
      expectedRekeys: args.includes('--expected-rekeys')
        ? Number(option('--expected-rekeys'))
        : NaN,
      backupPath: args.includes('--backup') ? option('--backup') : undefined,
    });
    console.log(JSON.stringify({ mode: 'apply', ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  audit,
  apply,
  makePlan,
  guardedUpdate,
  hasUniqueIndex,
  unchangedFieldsHash,
  completeBatch,
  CONFIRM_TOKEN,
  INDEX_KEY,
};
if (require.main === module)
  main().catch((error) => {
    // Never log the database URL, raw documents, or identity values on failure.
    console.error(
      JSON.stringify({
        error: 'Message identity maintenance failed',
        code: error.code ?? null,
        detail:
          error.constructor.name === 'Error'
            ? error.message
            : 'Database command failed; inspect privately',
      }),
    );
    process.exitCode = 1;
  });
