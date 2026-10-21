'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  strictEvaluations,
  retrievalMetrics,
  attachTrace,
  fingerprint,
  executionHealth,
  evidenceGroupCoverage,
} = require('./rag-evaluation-contract.cjs');
const { analyze } = require('./analyze-rag-benchmark.cjs');
const {
  normalizeJudgeOutput,
  buildDimensionPrompt,
} = require('./rag-semantic-judge.cjs');
const { outputFromMessage } = require('./run-langfuse-live-benchmark.cjs');

test('provider outages are classified independently of a successful fallback answer', () => {
  assert.deepEqual(
    executionHealth({
      route: { providerStatus: 'ERROR' },
      finalFailureSource: 'NONE',
    }),
    {
      status: 'DEGRADED',
      failedStages: ['route'],
    },
  );
  assert.equal(executionHealth({}).status, 'UNKNOWN');
  assert.equal(
    executionHealth({
      route: { providerStatus: 'SUCCESS' },
      routeDecision: { needsRetrieval: false, needsVerification: false },
      verification: { providerStatus: 'NOT_CALLED' },
    }).status,
    'AVAILABLE',
  );
  assert.equal(
    executionHealth({
      route: { providerStatus: 'NOT_CALLED', decisionSource: 'STRUCTURAL' },
      routeDecision: {
        needsRetrieval: false,
        needsVerification: false,
        reelQuestionType: 'AMBIGUOUS_REEL_REFERENCE',
      },
    }).status,
    'AVAILABLE',
  );
  assert.equal(
    executionHealth({
      route: { providerStatus: 'SUCCESS' },
      routeDecision: { needsRetrieval: true, needsVerification: true },
      contextSufficiency: {
        providerStatus: 'NOT_CALLED',
        decisionSource: 'DETERMINISTIC_NO_CONTEXT',
        sufficient: false,
      },
      finalFailureSource: 'NO_CONTEXT',
    }).status,
    'AVAILABLE',
  );
  assert.equal(
    executionHealth({
      route: { providerStatus: 'SUCCESS' },
      routeDecision: {
        needsRetrieval: false,
        needsVerification: true,
        intent: 'TASK_ACTION_REQUEST',
        toolPlan: { requiredTools: [] },
      },
      contextSufficiency: {
        providerStatus: 'NOT_CALLED',
        decisionSource: 'UNKNOWN',
        sufficient: true,
      },
      verification: { providerStatus: 'SUCCESS' },
    }).status,
    'AVAILABLE',
  );
  assert.equal(
    executionHealth({
      route: { providerStatus: 'SUCCESS' },
      routeDecision: {
        needsRetrieval: true,
        needsVerification: true,
      },
    }).status,
    'UNKNOWN',
  );
  assert.equal(
    executionHealth({
      route: { providerStatus: 'SUCCESS' },
      answerCalls: [{ providerStatus: 429 }],
    }).status,
    'DEGRADED',
  );
  assert.equal(
    executionHealth({
      route: {
        providerStatus: 'SUCCESS',
        semanticCalls: [{ providerStatus: 429 }, { providerStatus: 200 }],
      },
      routeDecision: { needsRetrieval: false, needsVerification: false },
      evaluationCapture: { contextCaptured: false },
      answerCalls: [{ providerStatus: 429 }, { providerStatus: 200 }],
      finalFailureSource: 'NONE',
    }).status,
    'AVAILABLE',
  );
});

test('same-Reel citations do not masquerade as chunk retrieval; unavailable differs from zero', () => {
  const expected = { evidenceIds: ['reel:r:chunk:0'], modality: 'VISUAL' };
  const unavailable = Object.fromEntries(
    strictEvaluations({}, expected, {
      citations: [{ reelId: 'r', evidenceType: 'TRANSCRIPT' }],
    }).map((s) => [s.name, s.value]),
  );
  assert.equal(unavailable.citation_modality_precision, 0);
  assert.equal(unavailable.retrieval_recall_at_5, undefined);
  assert.equal(unavailable.citation_source_recall, undefined);
  const zero = Object.fromEntries(
    strictEvaluations({}, expected, {
      citations: [],
      retrievedEvidenceIds: [],
    }).map((s) => [s.name, s.value]),
  );
  assert.equal(zero.retrieval_recall_at_5, 0);
});
test('ranked relevance metrics deduplicate results and reward early relevant evidence', () => {
  const metrics = retrievalMetrics(['a', 'b'], ['x', 'a', 'a', 'b']);
  assert.equal(metrics.retrieval_recall_at_5, 1);
  assert.equal(metrics.retrieval_mrr, 0.5);
  assert.ok(metrics.retrieval_ndcg_at_5 < 1);
});

test('alternative source IDs count as one evidence group for recall and citations', () => {
  const groups = [
    ['reel:r:chunk:13', 'reel:r:chunk:22', 'reel:r:chunk:21'],
    ['reel:r:visual:5'],
  ];
  const metrics = retrievalMetrics(groups, [
    'reel:r:chunk:22',
    'reel:r:visual:5',
  ]);
  assert.equal(metrics.retrieval_recall_at_5, 1);
  assert.equal(metrics.retrieval_ndcg_at_5, 1);
  assert.equal(metrics.retrieval_mrr, 1);
  assert.deepEqual(evidenceGroupCoverage(groups, new Set([
    'reel:r:chunk:22',
    'reel:r:visual:5',
  ])), { score: 1, covered: 2, required: 2 });
});

test('multiple retrieved alternatives for one source do not inflate evidence recall', () => {
  const groups = [['chunk:13', 'chunk:21', 'chunk:22']];
  const metrics = retrievalMetrics(groups, ['chunk:21', 'chunk:22']);
  assert.equal(metrics.retrieval_recall_at_5, 1);
  assert.equal(metrics.retrieval_ndcg_at_5, 1);
  assert.equal(metrics.retrieval_mrr, 1);
});

test('strict citation and generation metrics accept a source-backed alternative ID by modality', () => {
  const scores = Object.fromEntries(
    strictEvaluations(
      {},
      {
        evidenceIds: ['transcript:canonical', 'visual:canonical'],
        relevantEvidenceGroups: [
          ['transcript:canonical', 'transcript:overlap'],
          ['visual:canonical'],
        ],
        expectedEvidenceTypes: ['TRANSCRIPT', 'VISUAL'],
        modality: 'TRANSCRIPT',
      },
      {
        citations: [
          { evidenceType: 'TRANSCRIPT', evidenceId: 'transcript:overlap' },
        ],
        retrievedEvidenceIds: ['transcript:overlap', 'visual:canonical'],
        generationEvidence: [
          { evidenceType: 'TRANSCRIPT', sourceId: 'transcript:overlap' },
          { evidenceType: 'VISUAL', sourceId: 'visual:canonical' },
        ],
      },
    ).map((score) => [score.name, score.value]),
  );
  assert.equal(scores.citation_source_recall, 1);
  assert.equal(scores.generation_evidence_coverage, 1);
  assert.equal(scores.retrieval_recall_at_5, 1);
});
test('saved output only contains observed evidence and modality', () => {
  const output = outputFromMessage(
    {
      content: 'answer',
      citations: [{ evidenceId: 'observed', evidenceType: 'VISUAL' }],
    },
    { input: { evidenceIds: ['gold'], modality: 'TRANSCRIPT' } },
    'c',
  );
  assert.deepEqual(output.evidenceIds, ['observed']);
  assert.deepEqual(output.modalities, ['VISUAL']);
  assert.equal(output.modality, undefined);
});
test('trace attachment fails closed on conversation/answer/provenance mismatches', () => {
  const trace = {
    id: 't',
    conversationId: 'c',
    answer: 'yes',
    retrievedChunkIds: ['a'],
    workflowMetrics: { diagnostics: { productionExecutionId: 'p' } },
  };
  assert.throws(
    () => attachTrace({ answer: 'yes' }, trace, 'other'),
    /identity/,
  );
  assert.throws(() => attachTrace({ answer: 'no' }, trace, 'c'), /answer/);
  assert.equal(
    attachTrace({ answer: 'yes' }, trace, 'c').productionExecutionId,
    'p',
  );
});
test('missing and invalid judge dimensions are unavailable, never silently zero', () => {
  assert.throws(
    () => normalizeJudgeOutput({ faithfulness: { score: 0 } }),
    /unavailable/,
  );
  assert.throws(
    () => normalizeJudgeOutput({ faithfulness: { score: Infinity } }),
    /unavailable/,
  );
});
test('judge dimensions receive only the reference and evidence needed for their task', () => {
  const input = {
    question: 'QUESTION',
    referenceAnswer: 'GOLD_SECRET',
    generatedAnswer: 'ANSWER_SECRET',
    context: 'CONTEXT_SECRET',
  };
  const relevance = buildDimensionPrompt('responseRelevancy', input);
  assert.ok(relevance.includes('GOLD_SECRET'));
  assert.ok(!relevance.includes('CONTEXT_SECRET'));
  const faithfulness = buildDimensionPrompt('faithfulness', input);
  assert.ok(!faithfulness.includes('GOLD_SECRET'));
  assert.ok(faithfulness.includes('ANSWER_SECRET'));
  const completeness = buildDimensionPrompt('contextCompleteness', input);
  assert.ok(!completeness.includes('ANSWER_SECRET'));
  assert.ok(completeness.includes('GOLD_SECRET'));
});
test('offline replay does not mutate original state or fabricate unavailable metrics', () => {
  const state = {
    runId: 'r',
    cases: {
      a: {
        status: 'COMPLETED',
        conversationId: 'c',
        output: { answer: 'yes', citations: [] },
      },
    },
  };
  const before = fingerprint(state);
  const report = analyze(state, [
    {
      id: 'a',
      input: { modality: 'TRANSCRIPT' },
      expectedOutput: { answer: 'yes', evidenceIds: ['a'] },
    },
  ]);
  assert.equal(fingerprint(state), before);
  assert.equal(report.coverage.generationContextCases, 0);
  assert.equal(report.metrics.retrieval_mrr, undefined);
  assert.equal(report.metrics.answer_exact_match.mean, 1);
});

test('score publication identity uses the Langfuse trace, not the database RagTrace ID', () => {
  const trace = {
    id: 'database-trace',
    conversationId: 'c',
    workflowMetrics: {
      diagnostics: {
        productionExecutionId: 'p',
        langfuseTraceId: 'otel-trace',
      },
    },
  };
  const output = attachTrace({ answer: 'yes' }, trace, 'c');
  assert.equal(output.ragTraceId, 'database-trace');
  assert.equal(output.traceId, 'otel-trace');
});
