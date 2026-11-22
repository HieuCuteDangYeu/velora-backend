'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { staleEntries, withoutDeleted } = require('./cleanup-diverse-reels.cjs');

const map = {
  entries: {
    a: [{ reelId: 'a1', success: false, runId: 'r1' }, { reelId: 'a2', success: true, runId: 'r2' }],
    b: [{ reelId: 'b1', success: true }, { reelId: 'b2', success: true }],
    c: [{ reelId: 'c1', success: false }],
    d: [{ reelId: 'd1', success: true }],
  },
};

test('staleEntries keeps the newest successful reel of each fixture and flags the rest', () => {
  const ids = staleEntries(map).map((t) => t.reelId).sort();
  assert.deepEqual(ids, ['a1', 'b1', 'c1']);
});

test('withoutDeleted moves removed entries to `deleted` and never drops a kept one', () => {
  const next = withoutDeleted(map, ['a1', 'b1', 'c1'], 'T');
  assert.deepEqual(next.entries.a.map((e) => e.reelId), ['a2']);
  assert.deepEqual(next.entries.b.map((e) => e.reelId), ['b2']);
  assert.deepEqual(next.entries.c, []);
  assert.deepEqual(next.entries.d.map((e) => e.reelId), ['d1']);
  assert.deepEqual(next.deleted.map((e) => [e.fixtureId, e.reelId, e.deletedAt]), [['a', 'a1', 'T'], ['b', 'b1', 'T'], ['c', 'c1', 'T']]);
});
