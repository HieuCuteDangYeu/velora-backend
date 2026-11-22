'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { photoSourceReelIds } = require('./set-photo-source-visibility.cjs');

test('photoSourceReelIds maps expected source fixtures to their resolved reels, once each', () => {
  const map = { entries: { a: [{ reelId: 'r1', success: false }, { reelId: 'r2', success: true }], b: [{ reelId: 'r3', success: true }], c: [{ reelId: 'r4', success: false }] } };
  const rows = [
    { expect: { sourceFixtureId: 'a' } },
    { expect: { sourceFixtureId: 'a' } },
    { expect: { sourceFixtureId: 'b' } },
    { expect: { sourceFixtureId: 'c' } },
    { expect: {} },
  ];
  assert.deepEqual(photoSourceReelIds(rows, map).sort(), ['r2', 'r3']);
});
