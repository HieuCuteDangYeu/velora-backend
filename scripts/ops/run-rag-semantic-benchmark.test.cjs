'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIMENSIONS,
  isApplicable,
} = require('./rag-evaluation-applicability.cjs');
const { ELIGIBILITY_POLICY } = require('./rag-semantic-eligibility.cjs');
const {
  contextForJudge,
  pendingDimensionTasks,
  reconcileDimensionScores,
  semanticRows,
  unavailableScores,
  judgeFailureCode,
  parseArgs,
  JUDGES,
} = require('./run-rag-semantic-benchmark.cjs');

test('classifies judge usage limits and timeouts separately', () => {
  assert.equal(judgeFailureCode(new Error('ETIMEDOUT')), 'CLAUDE_TIMEOUT');
  assert.equal(judgeFailureCode(new Error('request timed out')), 'CLAUDE_TIMEOUT');
  assert.equal(judgeFailureCode(new Error('usage limit reached')), 'CLAUDE_USAGE_LIMIT');
  assert.equal(judgeFailureCode(new Error('invalid JSON output')), 'CLAUDE_JUDGE_ERROR');
});

const transcriptQuote = {
  id: 'case-1',
  input: { question: 'Quote the first complete sentence.' },
  expectedOutput: { referenceAnswer: 'The courier arrived.' },
  metadata: { bucket: 'TRANSCRIPT', answerType: 'QUOTE' },
};

test('Semantic judge context is withheld unless generation evidence was captured', () => {
  assert.equal(
    contextForJudge({
      evaluationCapture: { contextCaptured: false },
      generationEvidence: [{ evidenceText: 'private source text' }],
    }),
    undefined,
  );
  assert.deepEqual(
    contextForJudge({
      evaluationCapture: { contextCaptured: true },
      generationEvidence: [
        {
          evidenceId: 'e0',
          evidenceType: 'TRANSCRIPT',
          evidenceText: 'The courier arrived.',
        },
      ],
    }),
    [
      {
        sourceId: 'e0',
        title: undefined,
        evidenceType: 'TRANSCRIPT',
        startTime: undefined,
        endTime: undefined,
        evidenceText: 'The courier arrived.',
      },
    ],
  );
});

test('degraded applicable dimensions are withheld and never queued for the judge', () => {
  const scores = unavailableScores(transcriptQuote, 'DEGRADED', {});
  assert.deepEqual(Object.keys(scores).sort(), [...DIMENSIONS].sort());
  assert.ok(
    Object.values(scores).every(
      (score) => score.unavailableReason === 'EXECUTION_HEALTH_DEGRADED',
    ),
  );
  assert.deepEqual(
    pendingDimensionTasks([transcriptQuote], { 'case-1': { scores } }, (row) =>
      DIMENSIONS.filter((dimension) => isApplicable(row, dimension)),
    ),
    [],
  );
});

test('available answer and relevance dimensions can be judged without captured generation context', () => {
  const scores = unavailableScores(transcriptQuote, 'AVAILABLE', {
    answer: 'The courier arrived.',
    contextCaptureStatus: 'NOT_CAPTURED',
    generationEvidence: [],
    executionHealth: { status: 'AVAILABLE' },
  });

  assert.deepEqual(scores, {
    faithfulness: {
      unavailableReason: 'GENERATION_CONTEXT_NOT_CAPTURED',
    },
    contextCompleteness: {
      unavailableReason: 'GENERATION_CONTEXT_NOT_CAPTURED',
    },
  });
});

test('health-policy migration reopens scores withheld only by the old health label', () => {
  assert.deepEqual(
    reconcileDimensionScores(
      {
        faithfulness: { unavailableReason: 'EXECUTION_HEALTH_DEGRADED' },
        factualCorrectness: { score: 0.6, reasoning: 'retained' },
        responseRelevancy: { unavailableReason: 'EXECUTION_HEALTH_DEGRADED' },
      },
      {
        contextCompleteness: {
          unavailableReason: 'GENERATION_CONTEXT_NOT_CAPTURED',
        },
      },
    ),
    {
      factualCorrectness: { score: 0.6, reasoning: 'retained' },
      contextCompleteness: {
        unavailableReason: 'GENERATION_CONTEXT_NOT_CAPTURED',
      },
    },
  );
});

test('resume queues only unscored applicable dimensions', () => {
  const pending = pendingDimensionTasks(
    [transcriptQuote],
    {
      'case-1': {
        scores: {
          faithfulness: { score: 0.9, reasoning: 'grounded' },
          factualCorrectness: { unavailableReason: 'NOT_APPLICABLE' },
        },
      },
    },
    (row) => DIMENSIONS.filter((dimension) => isApplicable(row, dimension)),
  );
  assert.deepEqual(
    pending.map(({ caseId, dimension }) => [caseId, dimension]),
    [
      ['case-1', 'responseRelevancy'],
      ['case-1', 'contextCompleteness'],
    ],
  );
});

test('semantic output rows carry the required evaluator and eligibility versions', () => {
  const records = semanticRows(
    [transcriptQuote],
    { 'case-1': { scores: { faithfulness: { score: 0.9 } } } },
    {
      judgeFingerprint: 'judge-fingerprint',
      healthById: { 'case-1': 'AVAILABLE' },
    },
  );
  assert.deepEqual(records[0], {
    caseId: 'case-1',
    evaluatorVersion: 'velora-rag-evaluation-v10',
    eligibilityPolicy: ELIGIBILITY_POLICY,
    judgeProvider: 'claude-code-subscription',
    judgeModel: 'claude-haiku-5-5',
    judgeFingerprint: 'judge-fingerprint',
    executionHealth: 'AVAILABLE',
    scores: { faithfulness: { score: 0.9 } },
  });
});

test('only the Claude judge is selectable and it is the default', () => {
  assert.equal(parseArgs(['dataset', 'cohort']).judge, 'claude');
  assert.equal(
    parseArgs(['dataset', 'cohort', '--judge', 'claude']).judge,
    'claude',
  );
  assert.throws(
    () => parseArgs(['dataset', 'cohort', '--judge', 'codex']),
    /--judge must be one of/,
  );
  assert.equal(JUDGES.claude.model, 'claude-haiku-5-5');
  assert.equal(JUDGES.claude.stateFile, 'claude-semantic-state.json');
});

test('semantic rows record the Claude judge provider and model', () => {
  const [record] = semanticRows(
    [{ id: 'case-1' }],
    { 'case-1': { scores: {} } },
    { judgeFingerprint: 'fp', healthById: { 'case-1': 'AVAILABLE' } },
  );
  assert.equal(record.judgeProvider, 'claude-code-subscription');
  assert.equal(record.judgeModel, 'claude-haiku-5-5');
});
