'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dimensionAvailability } = require('./rag-semantic-eligibility.cjs');

test('scores answer and reference dimensions when generation context was not captured', () => {
  const availability = dimensionAvailability(
    {
      input: { question: 'What did the speaker say?' },
      expectedOutput: { referenceAnswer: 'A supported answer.' },
      metadata: { bucket: 'TRANSCRIPT' },
    },
    {
      answer: 'A supported answer.',
      contextCaptureStatus: 'NOT_CAPTURED',
      generationEvidence: [],
      executionHealth: { status: 'DEGRADED' },
    },
  );

  assert.equal(availability.responseRelevancy, 'AVAILABLE');
  assert.equal(availability.factualCorrectness, 'AVAILABLE');
  assert.equal(availability.faithfulness, 'GENERATION_CONTEXT_NOT_CAPTURED');
  assert.equal(
    availability.contextCompleteness,
    'GENERATION_CONTEXT_NOT_CAPTURED',
  );
});

test('treats captured empty evidence as observed context and preserves correct refusals', () => {
  const availability = dimensionAvailability(
    {
      input: { question: 'What happened in the clip?' },
      expectedOutput: { referenceAnswer: 'A supported answer.' },
      metadata: { bucket: 'TRANSCRIPT' },
    },
    {
      answer: 'I do not have enough evidence to answer.',
      contextCaptureStatus: 'CAPTURED',
      generationEvidence: [],
      executionHealth: { status: 'DEGRADED' },
    },
  );

  assert.deepEqual(availability, {
    faithfulness: 'AVAILABLE',
    factualCorrectness: 'AVAILABLE',
    responseRelevancy: 'AVAILABLE',
    contextCompleteness: 'AVAILABLE',
  });
});

test('uses available primary execution health as a legacy capture attestation', () => {
  const item = {
    input: { question: 'What did the speaker say?' },
    expectedOutput: { referenceAnswer: 'A supported answer.' },
    metadata: { bucket: 'TRANSCRIPT' },
  };
  const captured = dimensionAvailability(item, {
    answer: 'A supported answer.',
    generationEvidence: [{ evidenceText: 'captured source' }],
    executionHealth: { status: 'AVAILABLE' },
  });
  assert.equal(captured.faithfulness, 'AVAILABLE');
  assert.equal(captured.contextCompleteness, 'AVAILABLE');

  const explicitlyNotCaptured = dimensionAvailability(item, {
    answer: 'A supported answer.',
    contextCaptureStatus: 'NOT_CAPTURED',
    generationEvidence: [{ evidenceText: 'captured source' }],
    executionHealth: { status: 'AVAILABLE' },
  });
  assert.equal(
    explicitlyNotCaptured.faithfulness,
    'GENERATION_CONTEXT_NOT_CAPTURED',
  );
  assert.equal(
    explicitlyNotCaptured.contextCompleteness,
    'GENERATION_CONTEXT_NOT_CAPTURED',
  );
});

test('does not judge ambiguous clarification cases against a null factual reference', () => {
  const availability = dimensionAvailability(
    {
      input: { question: 'Which shared clip do you mean?' },
      expectedOutput: { referenceAnswer: null },
      metadata: { bucket: 'MULTI_REEL', answerType: 'CLARIFICATION' },
    },
    {
      answer: 'Which shared Reel did you mean?',
      contextCaptureStatus: 'NOT_CAPTURED',
      generationEvidence: [],
    },
  );

  assert.deepEqual(availability, {
    faithfulness: 'NOT_APPLICABLE',
    factualCorrectness: 'NOT_APPLICABLE',
    responseRelevancy: 'NOT_APPLICABLE',
    contextCompleteness: 'NOT_APPLICABLE',
  });
});
