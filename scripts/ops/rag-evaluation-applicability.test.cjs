'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applicability,
  isApplicable,
} = require('./rag-evaluation-applicability.cjs');

test('ordinary chat does not create false grounding/completeness failures', () => {
  const result = applicability({
    metadata: { bucket: 'CHAT', answerType: 'NORMAL_CHAT' },
  });
  assert.equal(result.responseRelevancy, true);
  assert.equal(result.faithfulness, false);
  assert.equal(result.factualCorrectness, false);
  assert.equal(result.contextCompleteness, false);
});

test('answerable Reel tasks keep all semantic dimensions applicable', () => {
  for (const bucket of [
    'TRANSCRIPT',
    'VISUAL',
    'COMBINED',
    'METADATA',
    'MULTI_REEL',
    'MEMORY',
  ]) {
    assert.equal(isApplicable({ metadata: { bucket } }, 'faithfulness'), true);
    assert.equal(
      isApplicable({ metadata: { bucket } }, 'contextCompleteness'),
      true,
    );
  }
});

test('refusal and recommendation cases use policy/action evaluators', () => {
  assert.equal(
    applicability({ metadata: { bucket: 'ABSTENTION' } }).contextCompleteness,
    false,
  );
  assert.equal(
    applicability({ metadata: { bucket: 'RECOMMENDATION' } })
      .factualCorrectness,
    false,
  );
});

test('clarification cases are separated from factual semantic scoring', () => {
  const result = applicability({
    metadata: { bucket: 'MULTI_REEL', answerType: 'CLARIFICATION' },
  });
  assert.equal(
    Object.values(result).filter((value) => value === true).length,
    0,
  );
});
