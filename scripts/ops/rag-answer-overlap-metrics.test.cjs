'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  answerOverlapMetrics,
  tokenF1,
} = require('./rag-answer-overlap-metrics.cjs');

test('reports exact match, containment, and token F1 as separate answer metrics', () => {
  const expectedOutput = { referenceAnswer: 'The red dog came back.' };
  assert.deepEqual(
    answerOverlapMetrics('The red dog came back!', expectedOutput),
    { exactMatch: 1, containment: 1, tokenF1: 1 },
  );
  const partial = answerOverlapMetrics('The dog returned.', expectedOutput);
  assert.equal(partial.exactMatch, 0);
  assert.equal(partial.containment, 0);
  assert.ok(partial.tokenF1 > 0);
});

test('uses the best accepted reference and marks null references unavailable', () => {
  assert.equal(
    answerOverlapMetrics('Exact alternative.', {
      acceptedAnswers: ['First option.', 'Exact alternative.'],
    }).exactMatch,
    1,
  );
  assert.deepEqual(
    answerOverlapMetrics('A refusal.', { referenceAnswer: null }),
    {
      exactMatch: null,
      containment: null,
      tokenF1: null,
    },
  );
  assert.equal(tokenF1('', 'reference'), 0);
});
