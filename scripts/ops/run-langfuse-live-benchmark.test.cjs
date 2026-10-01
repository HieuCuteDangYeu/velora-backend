const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateEvaluations,
  deterministicEvaluations,
  excludeInFlightCase,
  prepareInFlightRetry,
  tokenRecall,
} = require('./run-langfuse-live-benchmark.cjs');

test('reconciles one terminal provider failure without losing the original attempt', () => {
  const state = {
    cases: {
      case1: {
        status: 'IN_FLIGHT',
        attemptCount: 1,
        conversationId: 'conversation-1',
        userMessageId: 'message-1',
        requestStartedAt: '2026-09-30T00:00:00.000Z',
      },
    },
  };
  const next = prepareInFlightRetry(state, 'case1', 'TEI_RERANKER_OVERLOADED');
  assert.equal(next.cases.case1.status, 'PENDING');
  assert.equal(next.cases.case1.retryCount, 1);
  assert.equal(
    next.cases.case1.attemptHistory[0].failureCategory,
    'TEI_RERANKER_OVERLOADED',
  );
  assert.equal(state.cases.case1.status, 'IN_FLIGHT');
});

test('excludes an in-flight case only with the recorded infrastructure reason', () => {
  const state = {
    cases: {
      case1: {
        status: 'IN_FLIGHT',
        attemptCount: 1,
        conversationId: 'conversation-1',
        userMessageId: 'message-1',
      },
    },
  };
  const next = excludeInFlightCase(
    state,
    'case1',
    'CONVERSATION_DB_IO_TIMEOUT',
  );
  assert.equal(next.cases.case1.status, 'EXCLUDED');
  assert.equal(next.cases.case1.exclusionReason, 'CONVERSATION_DB_IO_TIMEOUT');
  assert.equal(state.cases.case1.status, 'IN_FLIGHT');
});

test('preserves an unresolved response timeout as an explicit exclusion', () => {
  const state = {
    cases: {
      case1: {
        status: 'IN_FLIGHT',
        attemptCount: 1,
        conversationId: 'conversation-1',
        userMessageId: 'message-1',
      },
    },
  };
  const next = excludeInFlightCase(
    state,
    'case1',
    'RAG_RESPONSE_TIMEOUT_UNRESOLVED',
  );
  assert.equal(next.cases.case1.status, 'EXCLUDED');
  assert.equal(
    next.cases.case1.exclusionReason,
    'RAG_RESPONSE_TIMEOUT_UNRESOLVED',
  );
});

test('scores a grounded exact answer deterministically', () => {
  const input = {
    reelIds: ['reel-1'],
    evidenceIds: ['evidence-1'],
    modality: 'TRANSCRIPT',
  };
  const expected = {
    answer: 'A verified answer.',
    reelIds: ['reel-1'],
    evidenceIds: ['evidence-1'],
    modality: 'TRANSCRIPT',
  };
  const output = {
    answer: 'A verified answer.',
    citations: [
      {
        reelId: 'reel-1',
        evidenceId: 'evidence-1',
        evidenceType: 'TRANSCRIPT',
      },
    ],
  };
  assert.deepEqual(
    deterministicEvaluations(input, expected, output).map((item) => item.value),
    [1, 1, 1, 1, 1],
  );
});

test('token recall and aggregate scores remain bounded', () => {
  assert.equal(tokenRecall('one two three', 'one three'), 2 / 3);
  const input = {
    reelIds: ['reel-1'],
    evidenceIds: ['evidence-1'],
    modality: 'TRANSCRIPT',
  };
  const expectedOutput = {
    answer: 'one two',
    reelIds: ['reel-1'],
    evidenceIds: ['evidence-1'],
    modality: 'TRANSCRIPT',
  };
  const output = {
    answer: 'one',
    citations: [
      {
        reelId: 'reel-1',
        evidenceId: 'evidence-1',
        evidenceType: 'TRANSCRIPT',
      },
    ],
  };
  const aggregate = aggregateEvaluations([{ input, expectedOutput, output }]);
  assert.equal(aggregate.answer_token_recall, 0.5);
  assert.ok(
    Object.values(aggregate).every((value) => value >= 0 && value <= 1),
  );
});

test('scores production-shaped RagCitationDto without explicit evidenceId deterministically', () => {
  const input = {
    reelIds: ['06d45cee-d6cd-4a2b-bb70-930a791d67b8'],
    evidenceIds: ['reel:06d45cee-d6cd-4a2b-bb70-930a791d67b8:chunk:0'],
    modality: 'TRANSCRIPT',
  };
  const expected = {
    answer: 'The narrator woke up with a fever.',
    reelIds: ['06d45cee-d6cd-4a2b-bb70-930a791d67b8'],
    evidenceIds: ['reel:06d45cee-d6cd-4a2b-bb70-930a791d67b8:chunk:0'],
    modality: 'TRANSCRIPT',
  };
  const output = {
    answer: 'The narrator woke up with a fever.',
    citations: [
      {
        sourceType: 'REEL',
        reelId: '06d45cee-d6cd-4a2b-bb70-930a791d67b8',
        evidenceType: 'TRANSCRIPT',
        title: 'Pet Chat Group Episode 22',
        startTime: 0,
        endTime: 44.78,
        quote: 'Woke up with a fever the next day.',
      },
    ],
  };
  assert.deepEqual(
    deterministicEvaluations(input, expected, output).map((item) => item.value),
    [1, 1, 1, 1, 1],
  );
});
