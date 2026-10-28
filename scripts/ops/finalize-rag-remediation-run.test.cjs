'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildExitGateMatrix,
  qualifyLangfuseReplay,
  qualifyReranker,
  assertSemanticEligibilityPolicy,
  semanticCasesFilename,
  validateCalibrationReview,
} = require('./finalize-rag-remediation-run.cjs');
const { EVALUATOR_VERSION } = require('./rag-evaluation-contract.cjs');
const { applicability } = require('./rag-evaluation-applicability.cjs');

assert.equal(
  semanticCasesFilename('semantic-cases-context-capture-v4.jsonl'),
  'semantic-cases-context-capture-v4.jsonl',
);
assert.throws(
  () => semanticCasesFilename('../semantic-cases.jsonl'),
  /basename/,
);
assert.equal(
  assertSemanticEligibilityPolicy(
    [{ eligibilityPolicy: 'dimension-evidence-v4' }],
    'candidate',
  ),
  'dimension-evidence-v4',
);
assert.throws(
  () =>
    assertSemanticEligibilityPolicy(
      [{ eligibilityPolicy: 'dimension-evidence-v3' }],
      'candidate',
    ),
  /dimension-evidence-v4/,
);

const calibrationDataDir = path.resolve(
  process.env.RAG_FINAL_DATA_DIR ||
    '.benchmarks/rag-memory-remediation-20261006-01/dataset-v5',
);
const calibrationDatasetRows = ['development', 'held_out'].flatMap((split) =>
  JSON.parse(
    fs.readFileSync(path.join(calibrationDataDir, `${split}.json`), 'utf8'),
  ),
);
const calibrationRow = calibrationDatasetRows[0];
const calibrationEvidenceIds =
  calibrationRow.expectedOutput.relevantEvidenceIds || [];
const calibrationEvidenceTypes =
  calibrationRow.expectedOutput.expectedEvidenceTypes || [];
const calibrationNeedsImageReview =
  calibrationEvidenceTypes.includes('VISUAL') ||
  calibrationEvidenceIds.some((id) => id.includes(':visual:'));
const calibrationCase = {
  caseId: calibrationRow.id,
  question: calibrationRow.input.question,
  referenceAnswer: calibrationRow.expectedOutput.referenceAnswer ?? null,
  bucket: calibrationRow.metadata.bucket,
  applicability: applicability(calibrationRow),
  reviewedLabel: 'PASS',
  relevantEvidenceIds: calibrationEvidenceIds,
  expectedEvidenceTypes: calibrationEvidenceTypes,
  requiresImageReview: calibrationNeedsImageReview,
  imageTruth: calibrationNeedsImageReview ? 'PASS' : null,
  reviewNotes: 'Review fields match the dataset fixture.',
};
const humanCalibration = {
  cases: [calibrationCase],
  independentReview: 'PASS',
};
const agentCalibration = {
  ...humanCalibration,
  humanApproved: false,
  reviewAuthority: 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH',
  reviewMetadata: { reviewerType: 'AGENT_SOURCE_AND_FRAME_REVIEW' },
};

const syntheticReviewRows = [
  {
    id: 'transcript-case',
    input: { question: 'Quote the indexed transcript.' },
    expectedOutput: {
      referenceAnswer: 'The source quote.',
      relevantEvidenceIds: ['reel:test:chunk:1'],
      expectedEvidenceTypes: ['TRANSCRIPT'],
    },
    metadata: { bucket: 'TRANSCRIPT', answerType: 'QUOTE' },
  },
  {
    id: 'visual-case',
    input: { question: 'Describe the frame at 2 seconds.' },
    expectedOutput: {
      referenceAnswer: 'A person opens the door.',
      relevantEvidenceIds: ['reel:test:visual:1'],
      expectedEvidenceTypes: ['VISUAL'],
    },
    metadata: { bucket: 'VISUAL', answerType: 'SCENE_DESCRIPTION' },
  },
];
const syntheticReviewById = new Map(
  syntheticReviewRows.map((row) => [row.id, row]),
);
const syntheticReview = {
  cases: [
    {
      caseId: 'transcript-case',
      question: syntheticReviewById.get('transcript-case').input.question,
      referenceAnswer:
        syntheticReviewById.get('transcript-case').expectedOutput
          .referenceAnswer,
      bucket: 'TRANSCRIPT',
      applicability: applicability(syntheticReviewById.get('transcript-case')),
      reviewedLabel: 'PASS',
      relevantEvidenceIds: ['reel:test:chunk:1'],
      expectedEvidenceTypes: ['TRANSCRIPT'],
      requiresImageReview: false,
      imageTruth: null,
      reviewNotes: 'Transcript source and expected passage match.',
    },
    {
      caseId: 'visual-case',
      question: syntheticReviewById.get('visual-case').input.question,
      referenceAnswer:
        syntheticReviewById.get('visual-case').expectedOutput.referenceAnswer,
      bucket: 'VISUAL',
      applicability: applicability(syntheticReviewById.get('visual-case')),
      reviewedLabel: 'PASS',
      relevantEvidenceIds: ['reel:test:visual:1'],
      expectedEvidenceTypes: ['VISUAL'],
      requiresImageReview: true,
      imageTruth: 'PASS',
      reviewNotes: 'The reviewed frame supports the visual reference.',
    },
  ],
};
assert.equal(
  validateCalibrationReview(syntheticReview, syntheticReviewRows),
  true,
);
assert.equal(
  validateCalibrationReview(
    { cases: [...syntheticReview.cases, syntheticReview.cases[0]] },
    syntheticReviewRows,
  ),
  false,
);
for (const invalidVisualCase of [
  { caseId: 'unknown-case' },
  { question: 'Wrong question.' },
  { referenceAnswer: 'Wrong reference.' },
  { bucket: 'TRANSCRIPT' },
  { applicability: { faithfulness: false } },
  { reviewedLabel: 'FAIL' },
  { relevantEvidenceIds: ['reel:wrong'] },
  { expectedEvidenceTypes: ['TRANSCRIPT'] },
  { requiresImageReview: false },
  { imageTruth: null },
  { reviewNotes: '  ' },
]) {
  assert.equal(
    validateCalibrationReview(
      {
        cases: [
          syntheticReview.cases[0],
          { ...syntheticReview.cases[1], ...invalidVisualCase },
        ],
      },
      syntheticReviewRows,
    ),
    false,
  );
}

const langfuseDatasetSha = 'a'.repeat(64);
const langfusePhases = [
  { phase: 'baseline', state: { buildFingerprint: 'b'.repeat(64) } },
  { phase: 'candidate', state: { buildFingerprint: 'c'.repeat(64) } },
];
const evaluatorTag = EVALUATOR_VERSION.replace(/[^A-Za-z0-9._-]/g, '-');
const langfuseLedger = {
  datasetSha256: langfuseDatasetSha,
  runs: Object.fromEntries(
    langfusePhases.map(({ phase, state }) => {
      const key = `${phase}-${langfuseDatasetSha.slice(0, 12)}-${state.buildFingerprint.slice(0, 12)}-${evaluatorTag}`;
      return [
        key,
        {
          status: 'COMPLETE',
          phase,
          itemCount: 400,
          toolObservationCount: 16,
          toolObservationsReadBack: true,
          datasetRunId: `run-${phase}`,
          runName: `RAG V8 ${phase} ${evaluatorTag} cached replay ${langfuseDatasetSha.slice(0, 12)} ${state.buildFingerprint.slice(0, 12)}`,
        },
      ];
    }),
  ),
};

assert.equal(
  qualifyLangfuseReplay(langfuseLedger, langfusePhases, langfuseDatasetSha, 400)
    .status,
  'PASS',
);
assert.equal(
  qualifyLangfuseReplay(undefined, langfusePhases, langfuseDatasetSha, 400)
    .status,
  'PENDING',
);
assert.equal(
  qualifyLangfuseReplay(
    { ...langfuseLedger, datasetSha256: 'd'.repeat(64) },
    langfusePhases,
    langfuseDatasetSha,
    400,
  ).status,
  'BLOCKED',
);
const partialLangfuseLedger = structuredClone(langfuseLedger);
const candidateKey = Object.keys(partialLangfuseLedger.runs).find((key) =>
  key.startsWith('candidate-'),
);
partialLangfuseLedger.runs[candidateKey].itemCount = 399;
assert.equal(
  qualifyLangfuseReplay(
    partialLangfuseLedger,
    langfusePhases,
    langfuseDatasetSha,
    400,
  ).status,
  'BLOCKED',
);
const noToolLangfuseLedger = structuredClone(langfuseLedger);
const baselineKey = Object.keys(noToolLangfuseLedger.runs).find((key) =>
  key.startsWith('baseline-'),
);
noToolLangfuseLedger.runs[baselineKey].toolObservationCount = 0;
assert.equal(
  qualifyLangfuseReplay(
    noToolLangfuseLedger,
    langfusePhases,
    langfuseDatasetSha,
    400,
  ).status,
  'BLOCKED',
);
const unverifiedToolLangfuseLedger = structuredClone(langfuseLedger);
delete unverifiedToolLangfuseLedger.runs[baselineKey].toolObservationsReadBack;
assert.equal(
  qualifyLangfuseReplay(
    unverifiedToolLangfuseLedger,
    langfusePhases,
    langfuseDatasetSha,
    400,
  ).status,
  'BLOCKED',
);

const result = {
  gates: {
    applicabilitySeparated: true,
    exactOncePrimaryResponses: true,
    exactOnceSemanticScores: true,
    structuredActionFailures: 0,
    privacyCanaryLeaks: 0,
    qualityTargets: 'BLOCKED',
    semanticEvaluatorConsistent: false,
    semanticEligibilityPolicyConsistent: false,
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

assert.equal(
  matrix.gates.find((gate) => gate.id === 'matched-primary').status,
  'PASS',
);
assert.equal(
  matrix.gates.find((gate) => gate.id === 'release-approval').status,
  'BLOCKED',
);
assert.equal(
  matrix.gates.find((gate) => gate.id === 'benchmark-quality').status,
  'BLOCKED',
);
assert.equal(
  matrix.gates.find((gate) => gate.id === 'calibration-dataset-binding').status,
  'BLOCKED',
);
assert.match(
  matrix.gates.find((gate) => gate.id === 'reliability').reason,
  /reranker/,
);

const releaseMatrix = buildExitGateMatrix(
  {
    ...result,
    productionRetrievalProven: true,
    gates: {
      ...result.gates,
      qualityTargets: 'PASS',
      semanticEvaluatorConsistent: true,
      semanticEligibilityPolicyConsistent: true,
    },
  },
  phases,
  { status: 'PASS' },
  { status: 'PASS', imageTruthStatus: 'PASS' },
  { status: 'PASS' },
  humanCalibration,
  { status: 'PASS' },
);
assert.equal(
  releaseMatrix.gates.find((gate) => gate.id === 'temporal-retrieval').status,
  'VERIFIED_BY_LIVE_OWNER_SERVICE',
);
assert.equal(
  releaseMatrix.gates.find((gate) => gate.id === 'release-approval').status,
  'PASS',
);
assert.equal(
  releaseMatrix.gates.find((gate) => gate.id === 'semantic-eligibility-policy')
    .status,
  'PASS',
);
assert.equal(
  releaseMatrix.gates.find((gate) => gate.id === 'calibration-dataset-binding')
    .status,
  'PASS',
);
assert.equal(
  releaseMatrix.gates.find((gate) => gate.id === 'langfuse-observability')
    .status,
  'NOT_REQUIRED',
);
const langfuseBlockedMatrix = buildExitGateMatrix(
  {
    ...result,
    productionRetrievalProven: true,
    gates: {
      ...result.gates,
      qualityTargets: 'PASS',
      semanticEvaluatorConsistent: true,
      semanticEligibilityPolicyConsistent: true,
    },
  },
  phases,
  { status: 'PASS' },
  { status: 'PASS', imageTruthStatus: 'PASS' },
  { status: 'PASS' },
  humanCalibration,
  { status: 'PASS' },
  {
    required: true,
    pass: false,
    status: 'PENDING',
    summary: 'Langfuse replay is not complete.',
  },
);
assert.equal(
  langfuseBlockedMatrix.gates.find(
    (gate) => gate.id === 'langfuse-observability',
  ).status,
  'PENDING',
);
assert.equal(
  langfuseBlockedMatrix.gates.find((gate) => gate.id === 'release-approval')
    .status,
  'BLOCKED',
);

const previousAuthority = process.env.RAG_FINAL_REVIEW_AUTHORITY;
process.env.RAG_FINAL_REVIEW_AUTHORITY = 'AGENT_AUTHORIZED_SOURCE_OF_TRUTH';
const agentMatrix = buildExitGateMatrix(
  {
    ...result,
    productionRetrievalProven: true,
    gates: {
      ...result.gates,
      qualityTargets: 'PASS',
      semanticEvaluatorConsistent: true,
      semanticEligibilityPolicyConsistent: true,
    },
  },
  phases,
  { status: 'PASS' },
  { status: 'PASS', imageTruthStatus: 'PASS' },
  { status: 'PASS' },
  agentCalibration,
  { status: 'PASS' },
);
assert.equal(
  agentMatrix.gates.find((gate) => gate.id === 'measurement-applicability')
    .status,
  'PASS',
);
assert.equal(
  agentMatrix.gates.find((gate) => gate.id === 'visual-evidence').status,
  'PASS',
);
assert.equal(
  agentMatrix.gates.find((gate) => gate.id === 'release-approval').status,
  'PASS',
);

const metrics = [
  'recallAt1',
  'recallAt3',
  'recallAt5',
  'recallAt10',
  'mrr',
  'ndcgAt5',
  'ndcgAt10',
  'evidenceHit',
];
const providerValidation = {
  schemaVersion: 'rag-provider-integration-validation-v3',
  status: 'PASS_PROVIDER_ADMISSION_ONLY',
  releaseSha: '5e78a743ce64080835eb32640bda37b1368af500',
  serviceImage:
    'hieucutedangyeu/ai-service:5e78a743ce64080835eb32640bda37b1368af500',
  productionRagRequestsMade: 0,
  langfuseWritesMade: 0,
  provider: {
    status: 'PASS',
    healthResponseOk: true,
    endpoint: 'TEI /rerank',
    model: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
    datasetVersion: 'rag-reranker-generalization-v1',
    datasetCaseCount: 2,
    rows: [{ id: 'tei-contract-nestjs-01' }, { id: 'tei-contract-budget-01' }],
    metrics: {
      tei: Object.fromEntries(metrics.map((metric) => [metric, 1])),
      baseline: Object.fromEntries(
        metrics.map((metric) => [metric, metric === 'recallAt1' ? 0.5 : 1]),
      ),
    },
  },
};
const previousExpectedReleaseSha = process.env.RAG_FINAL_RELEASE_SHA;
process.env.RAG_FINAL_RELEASE_SHA = providerValidation.releaseSha;
const rerankerResult = qualifyReranker(providerValidation);
assert.equal(rerankerResult.pass, true);
assert.equal(rerankerResult.method, 'DEPLOYED_TEI_SAFE_FIXTURE_NO_REGRESSION');
assert.equal(rerankerResult.caseCount, 2);
assert.match(
  rerankerResult.summary,
  /does not establish large-scale quality or latency/,
);
assert.equal(
  qualifyReranker({
    ...providerValidation,
    provider: {
      ...providerValidation.provider,
      metrics: {
        ...providerValidation.provider.metrics,
        tei: { ...providerValidation.provider.metrics.tei, recallAt1: 0 },
      },
    },
  }).pass,
  false,
);
process.env.RAG_FINAL_RELEASE_SHA = 'different-release';
assert.equal(qualifyReranker(providerValidation).pass, false);
process.env.RAG_FINAL_RELEASE_SHA = providerValidation.releaseSha;
const rerankerMatrix = buildExitGateMatrix(
  {
    ...result,
    productionRetrievalProven: true,
    gates: {
      ...result.gates,
      qualityTargets: 'PASS',
      semanticEvaluatorConsistent: true,
      semanticEligibilityPolicyConsistent: true,
    },
  },
  phases,
  { status: 'PASS' },
  { status: 'PASS', imageTruthStatus: 'PASS' },
  providerValidation,
  agentCalibration,
  { status: 'PASS' },
);
assert.equal(
  rerankerMatrix.gates.find(
    (gate) => gate.id === 'live-tei-reranker-qualification',
  ).status,
  'PASS',
);
assert.equal(
  rerankerMatrix.gates.find((gate) => gate.id === 'reliability').status,
  'OPERATIONAL_PASS',
);
assert.equal(
  rerankerMatrix.gates.find((gate) => gate.id === 'release-approval').status,
  'PASS',
);
if (previousExpectedReleaseSha === undefined)
  delete process.env.RAG_FINAL_RELEASE_SHA;
else process.env.RAG_FINAL_RELEASE_SHA = previousExpectedReleaseSha;
if (previousAuthority === undefined)
  delete process.env.RAG_FINAL_REVIEW_AUTHORITY;
else process.env.RAG_FINAL_REVIEW_AUTHORITY = previousAuthority;

console.log('RAG exit gate matrix checks passed');
