const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generate } = require('./generate-chat-stress-scale-fixtures.cjs');
const { roomIds, purgeMessages, purgeJobs, boundedUrl } = require('./purge-chat-stress-data.cjs');

const manifest = (users = 20) => {
  const input = generate({ users, baseUrl: 'https://velora.test' });
  input.rooms = Array.from({ length: users / 5 * 2 }, (_, i) => ({
    id: (i + 1).toString(16).padStart(24, '0'), name: `${input.fixtureNamespace} crowd ${String(i + 1).padStart(4, '0')}` }));
  return input;
};

const fakeConversationDb = (input, { messagesPerRoom = 3, renamed = [], missing = [] } = {}) => {
  const calls = { count: [], delete: [] };
  const rooms = input.rooms.filter(r => !missing.includes(r.id)).map(r => ({ id: r.id, name: renamed.includes(r.id) ? 'someone else' : r.name }));
  return { calls, conversation: { findMany: async () => rooms },
    message: {
      count: async ({ where }) => { calls.count.push(where.conversationId.in); return where.conversationId.in.length * messagesPerRoom },
      deleteMany: async ({ where }) => { calls.delete.push(where.conversationId.in); return { count: where.conversationId.in.length * messagesPerRoom } },
    } };
};

test('counts only unless --apply, and never touches rooms outside the manifest', async () => {
  const input = manifest();
  const db = fakeConversationDb(input);
  const result = await purgeMessages(db, input, { apply: false });
  assert.equal(result.messages, 8 * 3);
  assert.equal(result.deleted, 0);
  assert.equal(db.calls.delete.length, 0);
  const asked = new Set(db.calls.count.flat());
  assert.deepEqual([...asked].sort(), input.rooms.map(r => r.id).sort());
});

test('deletes batch by batch with a pause between batches', async () => {
  const input = manifest();
  const db = fakeConversationDb(input);
  const waits = [];
  const result = await purgeMessages(db, input, { apply: true, pauseMs: 40, wait: ms => waits.push(ms) });
  assert.equal(result.deleted, 8 * 3);
  assert.deepEqual(db.calls.delete.map(g => g.length), [5, 3]);
  assert.deepEqual(waits, [40, 40]);
});

test('a room that exists under another name blocks every delete', async () => {
  const input = manifest();
  const db = fakeConversationDb(input, { renamed: [input.rooms[2].id] });
  await assert.rejects(purgeMessages(db, input, { apply: true }), /different name/);
  assert.equal(db.calls.delete.length, 0);
});

test('rooms that no longer exist are skipped, not deleted blindly', async () => {
  const input = manifest();
  const db = fakeConversationDb(input, { missing: [input.rooms[0].id] });
  const result = await purgeMessages(db, input, { apply: true, pauseMs: 0 });
  assert.equal(result.rooms, 7);
  assert.ok(!db.calls.delete.flat().includes(input.rooms[0].id));
});

test('a manifest room outside the namespace or with a bad id is refused', () => {
  const input = manifest();
  input.rooms[0].name = 'other-namespace group';
  assert.throws(() => roomIds(input), /not a fixture room/);
  const bad = manifest(); bad.rooms[0].id = 'not-an-object-id';
  assert.throws(() => roomIds(bad), /not a fixture room/);
  const none = manifest(); none.rooms = [];
  assert.throws(() => roomIds(none), /no rooms/);
});

test('notification jobs are counted for fixture recipients only and deleted in bounded batches', async () => {
  const input = manifest();
  const executed = [];
  let remaining = 45000;
  const db = {
    $queryRaw: async (_strings, recipients) => { assert.equal(recipients.length, 20); return [{ count: 45000 }] },
    $executeRaw: async (_strings, recipients, limit) => {
      assert.equal(recipients.length, 20); assert.equal(limit, 20000);
      const removed = Math.min(limit, remaining); remaining -= removed; executed.push(removed); return removed;
    },
  };
  const dry = await purgeJobs(db, input, { apply: false });
  assert.deepEqual([dry.jobs, dry.deleted, executed.length], [45000, 0, 0]);
  const waits = [];
  const real = await purgeJobs(db, input, { apply: true, pauseMs: 10, wait: ms => waits.push(ms) });
  assert.equal(real.deleted, 45000);
  assert.deepEqual(executed, [20000, 20000, 5000]);
  assert.deepEqual(waits, [10, 10]);
});

test('postgres urls get a one-connection pool, mongo urls stay as configured', () => {
  assert.match(boundedUrl('postgres://u:p@h:5432/db?sslmode=require'), /connection_limit=1/);
  const mongo = 'mongodb://u:p@mongo:27017/conversation_db?authSource=conversation_db&replicaSet=rs0';
  assert.equal(boundedUrl(mongo), mongo);
});
