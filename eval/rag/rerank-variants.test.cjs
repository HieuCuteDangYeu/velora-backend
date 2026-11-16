'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { floor, rerankOrder, rrf } = require('./rerank-variants.cjs');

// Retrieval order a, b, c, d; the last hit (d) was not sent to the reranker.
const hits = [
  { id: 'a', rerankScore: 0.001 },
  { id: 'b', rerankScore: 0.9 },
  { id: 'c', rerankScore: 0.2 },
  { id: 'd' },
];

test('rerankOrder sorts reranked hits by score and keeps the tail', () => {
  assert.deepEqual(rerankOrder(hits), ['b', 'c', 'a', 'd']);
});

test('floor demotes or drops hits under the threshold', () => {
  assert.deepEqual(floor(hits, 0.01, false), ['b', 'c', 'a', 'd']);
  assert.deepEqual(floor(hits, 0.01, true), ['b', 'c', 'd']);
  assert.deepEqual(floor(hits, 0.5, false), ['b', 'a', 'c', 'd']);
});

test('rrf with weight 1 is rerank order and with weight 0 is retrieval order', () => {
  assert.deepEqual(rrf(hits, 1, 60), ['b', 'c', 'a', 'd']);
  assert.deepEqual(rrf(hits, 0, 60), ['a', 'b', 'c', 'd']);
});
