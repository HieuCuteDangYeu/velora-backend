'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applicability } = require('./rag-evaluation-applicability.cjs');

test('applicability preserves answer-task dimensions and excludes non-grounding tasks', () => {
  assert.deepEqual(applicability({ metadata: { bucket: 'CHAT' } }), {
    faithfulness: false,
    factualCorrectness: false,
    responseRelevancy: true,
    contextCompleteness: false,
    reason: 'Ordinary chat has no Reel evidence or reference fact.',
  });
  assert.equal(applicability({ metadata: { bucket: 'TRANSCRIPT' } }).contextCompleteness, true);
});
