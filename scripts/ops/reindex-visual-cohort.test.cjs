'use strict';

const assert = require('node:assert/strict');
const {
  parseArgs,
  positiveLimit,
  selectCandidates,
} = require('./reindex-visual-cohort.cjs');

assert.deepEqual(parseArgs(['--apply', '--limit=4']), { apply: true, limit: 4 });
assert.equal(positiveLimit(8), 8);
assert.throws(() => positiveLimit(0), /between 1 and 32/);
assert.deepEqual(
  selectCandidates(
    [
      { id: 'old', title: 'old' },
      { id: 'done', title: 'done' },
      { id: 'next', title: 'next' },
    ],
    [{ reelId: 'done', count: 24 }],
    2,
  ).map((reel) => reel.id),
  ['old', 'next'],
);

console.log('reindex visual cohort checks passed');
