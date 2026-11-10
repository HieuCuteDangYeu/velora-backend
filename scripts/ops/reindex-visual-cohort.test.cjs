'use strict';

const assert = require('node:assert/strict');
const {
  parseArgs,
  positiveLimit,
  selectCandidates,
} = require('./reindex-visual-cohort.cjs');

assert.deepEqual(parseArgs(['--apply', '--limit=4']), {
  apply: true,
  flat: false,
  limit: 4,
});
assert.deepEqual(parseArgs(['--apply', '--flat', '--limit=1']), {
  apply: true,
  flat: true,
  limit: 1,
});
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

// Flat mode picks reels that still have unlabelled scenes, oldest first, and skips reels with none.
assert.deepEqual(
  selectCandidates(
    [
      { id: 'labelled', title: 'labelled' },
      { id: 'flat-a', title: 'flat-a' },
      { id: 'no-scenes', title: 'no-scenes' },
      { id: 'flat-b', title: 'flat-b' },
    ],
    [
      { reelId: 'labelled', count: 24, flat: 0 },
      { reelId: 'flat-a', count: 24, flat: 10 },
      { reelId: 'flat-b', count: 12, flat: 12 },
    ],
    5,
    true,
  ).map((reel) => reel.id),
  ['flat-a', 'flat-b'],
);

console.log('reindex visual cohort checks passed');
