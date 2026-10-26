'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCalibrationPrompt,
  buildLangfuseItem,
} = require('./run-rag-codex-judge.cjs');

const row = {
  id: 'case-1',
  input: { question: 'Quote the first complete sentence.' },
  expectedOutput: { answer: 'The first sentence.' },
  metadata: { answerType: 'TRANSCRIPT_QUOTE', bucket: 'TRANSCRIPT' },
};

function response(contextCaptured, generationEvidence) {
  return {
    output: { answer: 'The first sentence.' },
    trace: {
      workflowMetrics: {
        diagnostics: {
          evaluationCapture: { contextCaptured },
          generationEvidence,
        },
      },
    },
  };
}

test('Codex relevancy prompts include evidence only after explicit context capture', () => {
  const evidence = [
    { evidenceType: 'TRANSCRIPT', evidenceText: 'The first sentence.' },
  ];
  const capturedPrompt = buildCalibrationPrompt(
    'responseRelevancy',
    row,
    response(true, evidence),
  );
  const uncapturedPrompt = buildCalibrationPrompt(
    'responseRelevancy',
    row,
    response(false, evidence),
  );
  const capturedEmptyPrompt = buildCalibrationPrompt(
    'responseRelevancy',
    row,
    response(true, []),
  );

  assert.equal(
    JSON.parse(capturedPrompt.split('DATA:\n')[1]).generationEvidence,
    '[Source 1] Type: TRANSCRIPT | Evidence: "The first sentence."',
  );
  assert.equal(
    JSON.parse(uncapturedPrompt.split('DATA:\n')[1]).generationEvidence,
    undefined,
  );
  assert.equal(
    JSON.parse(capturedEmptyPrompt.split('DATA:\n')[1]).generationEvidence,
    'No context retrieved.',
  );
});

test('Langfuse Codex calibration items preserve context capture status', () => {
  const evidence = [{ evidenceText: 'The first sentence.' }];
  const captured = buildLangfuseItem(
    { row },
    response(true, evidence),
    'a'.repeat(64),
  );
  const uncaptured = buildLangfuseItem(
    { row },
    response(false, evidence),
    'a'.repeat(64),
  );

  assert.deepEqual(captured.input.generationEvidence, evidence);
  assert.equal(captured.metadata.contextCaptured, true);
  assert.deepEqual(uncaptured.input.generationEvidence, []);
  assert.equal(uncaptured.metadata.contextCaptured, false);
});
