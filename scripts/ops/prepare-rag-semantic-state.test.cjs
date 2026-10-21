'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { executionHealth } = require('./prepare-rag-semantic-state.cjs');

test('execution health separates provider recovery from missing context capture', () => {
  const result = executionHealth({
    output: { answer: 'A recovered answer.' },
    trace: {
      workflowMetrics: {
        diagnostics: {
          route: {
            providerStatus: 'SUCCESS',
            semanticCalls: [{ providerStatus: 429 }, { providerStatus: 200 }],
          },
          routeDecision: { needsRetrieval: false, needsVerification: false },
          evaluationCapture: { contextCaptured: false },
          answerCalls: [{ providerStatus: 429 }, { providerStatus: 200 }],
          finalFailureSource: 'NONE',
        },
      },
    },
  });

  assert.equal(result.status, 'AVAILABLE');
});

test('execution errors remain failed regardless of fallback diagnostics', () => {
  assert.deepEqual(executionHealth({ error: { code: 'WORKFLOW_ERROR' } }), {
    status: 'FAILED',
    failedStages: ['WORKFLOW_ERROR'],
  });
});
