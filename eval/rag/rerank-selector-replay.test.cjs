'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { selectVariant } = require('./rerank-selector-replay.cjs');

// Stand-in selector with the real contract: highest relevance first, capped at limit.
const selector = {
  select: (scored, limit) =>
    [...scored]
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit)
      .map((s) => s.candidate),
};
const scored = [
  { candidate: { chunkId: 'a' }, relevanceScore: 0.001, retrievalRank: 1 },
  { candidate: { chunkId: 'b' }, relevanceScore: 0.9, retrievalRank: 2 },
  { candidate: { chunkId: 'c' }, relevanceScore: 0.0005, retrievalRank: 3 },
  { candidate: { chunkId: 'd' }, relevanceScore: 0.3, retrievalRank: 4 },
];
const ids = (list) => list.map((c) => c.chunkId);

test('no floor is the selector on all candidates', () => {
  assert.deepEqual(ids(selectVariant(selector, scored, 4, null, false)), [
    'b',
    'd',
    'a',
    'c',
  ]);
});

test('floor keeps high candidates first and orders the demoted ones by retrieval rank', () => {
  // c scores lower than a, but a was retrieved earlier, so a comes first among the demoted.
  assert.deepEqual(ids(selectVariant(selector, scored, 4, 0.01, false)), [
    'b',
    'd',
    'a',
    'c',
  ]);
  // Swap the reranker scores of a and c: rerank order puts c first, the floor puts a first.
  const swapped = scored.map((s) =>
    s.candidate.chunkId === 'a'
      ? { ...s, relevanceScore: 0.0005 }
      : s.candidate.chunkId === 'c'
        ? { ...s, relevanceScore: 0.001 }
        : s,
  );
  assert.deepEqual(ids(selectVariant(selector, swapped, 4, null, false)), [
    'b',
    'd',
    'c',
    'a',
  ]);
  assert.deepEqual(ids(selectVariant(selector, swapped, 4, 0.01, false)), [
    'b',
    'd',
    'a',
    'c',
  ]);
});

test('floor falls back to retrieval order when nothing clears it, and drop removes the low ones', () => {
  const allLow = scored.map((s) => ({
    ...s,
    relevanceScore: s.relevanceScore / 1000,
  }));
  assert.deepEqual(ids(selectVariant(selector, allLow, 4, 0.01, false)), [
    'a',
    'b',
    'c',
    'd',
  ]);
  assert.deepEqual(ids(selectVariant(selector, scored, 4, 0.01, true)), [
    'b',
    'd',
  ]);
});
