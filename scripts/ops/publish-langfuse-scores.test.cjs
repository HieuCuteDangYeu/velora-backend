const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deterministicScores,
  evidenceRecall,
} = require('./publish-langfuse-scores.cjs');

test('deterministic score plumbing is provider-free and evidence-aware', () => {
  assert.equal(evidenceRecall(['e1', 'e2'], ['e2', 'e3']), 0.5);
  assert.deepEqual(
    deterministicScores({
      expectedOutput: {
        answer: 'Grounded answer',
        evidenceIds: ['e1'],
        modality: 'TRANSCRIPT',
      },
      output: {
        answer: ' grounded  answer ',
        evidenceIds: ['e1'],
        modality: 'TRANSCRIPT',
      },
    }),
    [
      { name: 'deterministic_exact_match', value: 1 },
      { name: 'deterministic_evidence_recall', value: 1 },
      { name: 'deterministic_modality_match', value: 1 },
    ],
  );
});
