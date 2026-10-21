'use strict';

const assert = require('node:assert/strict');
const { buildExitGateMatrix } = require('./finalize-rag-remediation-run.cjs');

const result = {
  gates: {
    applicabilitySeparated: true,
    exactOncePrimaryResponses: true,
    exactOnceSemanticScores: true,
    structuredActionFailures: 0,
    privacyCanaryLeaks: 0,
    qualityTargets: 'BLOCKED',
    semanticEvaluatorConsistent: false,
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
assert.equal(matrix.gates.find((gate) => gate.id === 'benchmark-quality').status, 'BLOCKED');
assert.match(matrix.gates.find((gate) => gate.id === 'reliability').reason, /reranker/);

const releaseMatrix = buildExitGateMatrix(
  { ...result, productionRetrievalProven: true, gates: { ...result.gates, qualityTargets: 'PASS', semanticEvaluatorConsistent: true } },
  phases,
  { status: 'PASS' },
  { status: 'PASS', imageTruthStatus: 'PASS' },
  { status: 'PASS' },
  {
    cases: [{ reviewedLabel: 'PASS' }],
    independentReview: 'PASS',
  },
  { status: 'PASS' },
);
assert.equal(releaseMatrix.gates.find((gate) => gate.id === 'temporal-retrieval').status, 'VERIFIED_BY_LIVE_OWNER_SERVICE');
assert.equal(releaseMatrix.gates.find((gate) => gate.id === 'release-approval').status, 'PASS');

const previousAuthority = process.env.RAG_FINAL_REVIEW_AUTHORITY;
process.env.RAG_FINAL_REVIEW_AUTHORITY = 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH';
const agentMatrix = buildExitGateMatrix(
  { ...result, productionRetrievalProven: true, gates: { ...result.gates, qualityTargets: 'PASS', semanticEvaluatorConsistent: true } },
  phases,
  { status: 'PASS' },
  { status: 'PASS', imageTruthStatus: 'PASS' },
  { status: 'PASS' },
  {
    status: 'AGENT_REVIEW_COMPLETE',
    humanApproved: false,
    reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
    reviewMetadata: { reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW' },
    cases: [{ reviewedLabel: 'PASS' }],
    independentReview: null,
  },
  { status: 'PASS' },
);
assert.equal(agentMatrix.gates.find((gate) => gate.id === 'measurement-applicability').status, 'PASS');
assert.equal(agentMatrix.gates.find((gate) => gate.id === 'visual-evidence').status, 'PASS');
assert.equal(agentMatrix.gates.find((gate) => gate.id === 'release-approval').status, 'PASS');
if (previousAuthority === undefined) delete process.env.RAG_FINAL_REVIEW_AUTHORITY;
else process.env.RAG_FINAL_REVIEW_AUTHORITY = previousAuthority;

console.log('RAG exit gate matrix checks passed');
