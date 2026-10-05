'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  apply,
  makePlan,
  guardedUpdate,
  hasUniqueIndex,
  unchangedFieldsHash,
  completeBatch,
  CONFIRM_TOKEN,
  INDEX_KEY,
} = require('./repair-message-identity-index.cjs');

const oid = (last) => ({ $oid: `00000000000000000000000${last}` });
const identity = {
  conversationId: oid(9),
  senderId: 'sender',
  clientMessageId: 'original-key',
};
const changes = makePlan([{ _id: identity, ids: [oid(1), oid(2)] }]);
const original = {
  _id: oid(2),
  ...identity,
  content: 'encrypted',
  replyToId: oid(8),
  createdAt: { $date: '2026-10-05T00:00:00Z' },
  metadata: { a: 1, b: 2 },
};
const before = { totalMessages: 2, duplicateGroups: 1, changes, indexes: [] };
const batch = (rows) => ({
  cursor: { id: { $numberLong: '0' }, firstBatch: rows },
});

function options(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-identity-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    confirm: CONFIRM_TOKEN,
    writersPaused: true,
    expectedRekeys: 1,
    backupPath: path.join(dir, 'backup.json'),
  };
}

function fakePrisma({ changedContent = false, updateMiss = false } = {}) {
  let stored = structuredClone(original);
  let indexed = false;
  const commands = [];
  return {
    commands,
    async $runCommandRaw(command) {
      commands.push(command);
      if (command.find) return batch([stored]);
      if (command.update) {
        if (updateMiss) return { nModified: 0 };
        stored.clientMessageId = changes[0].replacement;
        if (changedContent) stored.content = 'wrong';
        return { nModified: 1 };
      }
      if (command.count)
        return { n: Object.keys(command.query).length ? 0 : 2 };
      if (command.aggregate) return batch([]);
      if (command.listIndexes)
        return batch(indexed ? [{ key: INDEX_KEY, unique: true }] : []);
      if (command.createIndexes) {
        indexed = true;
        return { ok: 1 };
      }
      throw new Error('Unexpected command');
    },
  };
}

test('keeps the oldest identity and gives each extra row a deterministic key', () => {
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].id, oid(2));
  assert.equal(changes[0].previous, 'original-key');
  assert.equal(
    changes[0].replacement,
    'legacy-duplicate:000000000000000000000002',
  );
  assert.equal(makePlan([{ _id: identity, ids: [oid(1)] }]).length, 0);
});

test('updates only clientMessageId with exact identity matching and no upsert', () => {
  const update = guardedUpdate(changes[0]);
  assert.deepEqual(update.q, { _id: oid(2), ...identity });
  assert.deepEqual(update.u, {
    $set: { clientMessageId: changes[0].replacement },
  });
  assert.equal(update.multi, false);
  assert.equal(update.upsert, false);
});

test('rejects incomplete audit cursors', () => {
  assert.throws(
    () =>
      completeBatch({ cursor: { id: { $numberLong: '123' }, firstBatch: [] } }),
    /truncated plan/,
  );
  assert.deepEqual(completeBatch(batch([])), []);
});

test('requires a full compound unique index; sparse or partial protection is insufficient', () => {
  assert.equal(hasUniqueIndex([{ key: INDEX_KEY, unique: true }]), true);
  assert.equal(hasUniqueIndex([{ key: INDEX_KEY }]), false);
  assert.equal(
    hasUniqueIndex([
      {
        key: INDEX_KEY,
        unique: true,
        partialFilterExpression: { clientMessageId: { $exists: true } },
      },
    ]),
    false,
  );
  assert.equal(
    hasUniqueIndex([{ key: INDEX_KEY, unique: true, sparse: true }]),
    false,
  );
});

test('preservation hash ignores only clientMessageId and object field order', () => {
  const rekeyed = {
    ...original,
    clientMessageId: 'new',
    metadata: { b: 2, a: 1 },
  };
  assert.equal(unchangedFieldsHash(original), unchangedFieldsHash(rekeyed));
  assert.notEqual(
    unchangedFieldsHash(original),
    unchangedFieldsHash({ ...rekeyed, replyToId: oid(7) }),
  );
});

test('requires explicit confirmation, paused writers and approved rekey count', async (t) => {
  const config = options(t);
  const p = fakePrisma();
  await assert.rejects(
    () => apply(p, before, { ...config, confirm: undefined }),
    /confirmation/,
  );
  await assert.rejects(
    () => apply(p, before, { ...config, writersPaused: false }),
    /paused/,
  );
  await assert.rejects(
    () => apply(p, before, { ...config, expectedRekeys: 0 }),
    /approved count/,
  );
  assert.equal(p.commands.length, 0);
});

test('makes a private durable backup before changing identity and preserves all other fields', async (t) => {
  const config = options(t);
  const p = fakePrisma();
  const result = await apply(p, before, config);
  assert.deepEqual(result, {
    totalMessages: 2,
    rekeyed: 1,
    uniqueIndex: true,
    otherFieldsPreserved: true,
  });
  const backup = JSON.parse(fs.readFileSync(config.backupPath, 'utf8'));
  assert.deepEqual(backup.originals, [original]);
  assert.equal(fs.statSync(config.backupPath).mode & 0o777, 0o600);
  assert.equal(
    p.commands.some((c) => c.delete || c.drop || c.dropIndexes),
    false,
  );
});

test('refuses to overwrite backup and performs no mutation', async (t) => {
  const config = options(t);
  fs.writeFileSync(config.backupPath, 'previous-backup');
  const p = fakePrisma();
  await assert.rejects(() => apply(p, before, config), /EEXIST/);
  assert.equal(
    p.commands.some((c) => c.update || c.createIndexes),
    false,
  );
});

test('does not create an index when the guarded update misses a row', async (t) => {
  const p = fakePrisma({ updateMiss: true });
  await assert.rejects(
    () => apply(p, before, options(t)),
    /not fully confirmed/,
  );
  assert.equal(
    p.commands.some((c) => c.createIndexes),
    false,
  );
});

test('does not create an index if another field changed', async (t) => {
  const p = fakePrisma({ changedContent: true });
  await assert.rejects(
    () => apply(p, before, options(t)),
    /preservation verification failed/,
  );
  assert.equal(
    p.commands.some((c) => c.createIndexes),
    false,
  );
});
