'use strict';

const assert = require('node:assert/strict');
const { buildExitGateMatrix } = require('./finalize-rag-remediation-run.cjs');

const result = {
  gates: {
    applicabilitySeparated: true,
    exactOncePrimaryResponses: true,
    exactOnceSemanticScores: true,
    structuredActionFailures: 0,
  },
  productionRetrievalProven: false,
};
const phases = [
  { phase: 'baseline', state: { status: 'COMPLETE_WITH_EXECUTION_FAILURES' } },
  { phase: 'candidate', state: { status: 'COMPLETE_WITH_EXECUTION_FAILURES' } },
];
const matrix = buildExitGateMatrix(
  result,
  phases,
  { status: 'PASS' },
  { status: 'PASS' },
  { status: 'BLOCK' },
  { cases: [{ reviewedLabel: null }], independentReview: null },
);

assert.equal(matrix.gates.find((gate) => gate.id === 'matched-primary').status, 'PASS');
assert.equal(matrix.gates.find((gate) => gate.id === 'release-approval').status, 'BLOCKED');
assert.match(matrix.gates.find((gate) => gate.id === 'reliability').reason, /reranker/);

console.log('RAG exit gate matrix checks passed');
