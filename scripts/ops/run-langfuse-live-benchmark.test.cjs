const assert = require('node:assert/strict');
const test = require('node:test');

const {
  aggregateEvaluations,
  aggregateLatency,
  benchmarkEvaluations,
  containmentMatch,
  deterministicEvaluations,
  excludeInFlightCase,
  executionHealthCounts,
  isFullReleaseSha,
  isClearAbstention,
  prepareInFlightRetry,
  reelIdsForItem,
  shareReels,
  tokenF1,
  tokenRecall,
} = require('./run-langfuse-live-benchmark.cjs');
const { strictEvaluations } = require('./rag-evaluation-contract.cjs');

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

test('requires a full immutable service SHA for a non-provisional dataset run', () => {
  assert.equal(
    isFullReleaseSha('2360fcb32fd09da0c106fcb18bb819045c8ac705'),
    true,
  );
  assert.equal(isFullReleaseSha('2360fcb'), false);
  assert.equal(isFullReleaseSha(''), false);
});

test('aggregates workflow latency and degraded/unknown health without treating unknown as healthy', () => {
  const cases = [
    {
      output: {
        workflowLatencyMs: 100,
        executionHealth: { status: 'AVAILABLE' },
      },
    },
    {
      output: {
        workflowLatencyMs: 300,
        executionHealth: { status: 'DEGRADED' },
      },
    },
    { output: { workflowLatencyMs: null } },
  ];
  assert.deepEqual(aggregateLatency(cases), {
    count: 2,
    meanMs: 200,
    p50Ms: 100,
    p95Ms: 300,
  });
  assert.deepEqual(executionHealthCounts(cases), {
    AVAILABLE: 1,
    DEGRADED: 1,
    UNKNOWN: 1,
  });
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
    [1, 1, 1, 1, 1, 1, 1],
  );
});

test('scores against source-reviewed accepted answer variants', () => {
  const input = {
    reelIds: ['reel-1'],
    evidenceIds: ['reel:reel-1:chunk:0'],
    modality: 'TRANSCRIPT',
  };
  const expectedOutput = {
    answer: 'The speaker asks their parents to forgive them.',
    acceptedAnswers: ['Forgive me.'],
    reelIds: ['reel-1'],
    evidenceIds: ['reel:reel-1:chunk:0'],
    modality: 'TRANSCRIPT',
  };
  const output = {
    answer: 'Forgive me.',
    citations: [
      {
        reelId: 'reel-1',
        evidenceId: 'reel:reel-1:chunk:0',
        evidenceType: 'TRANSCRIPT',
      },
    ],
  };
  const scores = Object.fromEntries(
    deterministicEvaluations(input, expectedOutput, output).map((item) => [
      item.name,
      item.value,
    ]),
  );
  assert.equal(scores.answer_exact_match, 1);
  assert.equal(scores.answer_containment_match, 1);
  assert.equal(scores.answer_token_f1, 1);
  assert.equal(scores.answer_token_recall, 1);
  assert.equal(scores.reel_citation_match, 1);
  assert.equal(scores.modality_match, 1);
});

test('token recall, token F1, and aggregate scores remain bounded', () => {
  assert.equal(tokenRecall('one two three', 'one three'), 2 / 3);
  assert.equal(
    tokenF1('one two three', 'one three'),
    (2 * 1 * (2 / 3)) / (1 + 2 / 3),
  );
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
  assert.equal(aggregate.answer_token_f1, (2 * 1 * 0.5) / (1 + 0.5));
  assert.equal(aggregate.answer_containment_match, 1);
  assert.ok(
    Object.values(aggregate).every((value) => value >= 0 && value <= 1),
  );
});

test('containmentMatch handles preambles and concise answers robustly', () => {
  assert.equal(
    containmentMatch(
      "The Broken Hero's Return Episode 17",
      'The title of the Reel is "The Broken Hero\'s Return Episode 17".',
    ),
    1,
  );
  assert.equal(
    containmentMatch('You betrayed 12 of The abandoned human girl.', '12'),
    1,
  );
  assert.equal(
    containmentMatch(
      'You prepared all this for me?',
      'The opening statement is: “You prepared all this for me?”',
    ),
    1,
  );
  assert.equal(
    containmentMatch(
      'totally unrelated sentence',
      'something completely different',
    ),
    0,
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
    [1, 1, 1, 1, 1, 1, 1],
  );
});

test('shares every unique Reel required by a multi-Reel live case', async () => {
  const item = {
    id: 'multi',
    input: { reelIds: ['reel-a', 'reel-b', 'reel-a'] },
  };
  const reelIds = reelIdsForItem(item);
  const calls = [];
  await shareReels(
    async (method, route, body) => calls.push({ method, route, body }),
    'chat-1',
    reelIds,
  );
  assert.deepEqual(
    calls.map((call) => call.route),
    ['/content/reels/reel-a/share', '/content/reels/reel-b/share'],
  );
  assert(calls.every((call) => call.body.conversationId === 'chat-1'));
  assert.throws(
    () => reelIdsForItem({ id: 'invalid', input: { reelIds: [''] } }),
    /invalid dataset Reel IDs/,
  );
});

test('scores mixed transcript and visual evidence against its per-source modality', () => {
  const input = {
    reelIds: ['reel-1'],
    evidenceIds: ['reel-1:visual:4', 'reel-1:chunk:2'],
  };
  const expectedOutput = {
    answer: 'Visible: a blue robe. Said: she waited ten years.',
    reelIds: ['reel-1'],
    evidenceIds: ['reel-1:visual:4', 'reel-1:chunk:2'],
    expectedEvidenceTypes: ['VISUAL', 'TRANSCRIPT'],
  };
  const output = {
    answer: expectedOutput.answer,
    citations: [
      {
        reelId: 'reel-1',
        evidenceId: 'reel-1:visual:4',
        evidenceType: 'VISUAL',
      },
      {
        reelId: 'reel-1',
        evidenceId: 'reel-1:chunk:2',
        evidenceType: 'TRANSCRIPT',
      },
    ],
    retrievedEvidenceIds: input.evidenceIds,
  };
  const deterministic = deterministicEvaluations(input, expectedOutput, output);
  assert.equal(deterministic[5].value, 1);
  assert.equal(deterministic[6].value, 1);
  const strict = Object.fromEntries(
    strictEvaluations(input, expectedOutput, output).map((score) => [
      score.name,
      score.value,
    ]),
  );
  assert.equal(strict.citation_modality_precision, 1);
  assert.equal(strict.citation_source_recall, 1);
  assert.equal(strict.retrieval_recall_at_5, 1);
});

test('multi-Reel citation match requires every expected Reel', () => {
  const input = { reelIds: ['reel-1', 'reel-2'] };
  const expectedOutput = {
    answer: 'Both clips.',
    reelIds: ['reel-1', 'reel-2'],
  };
  const oneCitation = {
    answer: 'Both clips.',
    citations: [{ reelId: 'reel-1', evidenceType: 'TRANSCRIPT' }],
  };
  const bothCitations = {
    ...oneCitation,
    citations: [
      ...oneCitation.citations,
      { reelId: 'reel-2', evidenceType: 'TRANSCRIPT' },
    ],
  };
  assert.equal(
    deterministicEvaluations(input, expectedOutput, oneCitation)[5].value,
    0,
  );
  assert.equal(
    deterministicEvaluations(input, expectedOutput, bothCitations)[5].value,
    1,
  );
});

test('abstention with no relevant evidence passes only when it emits no citations', () => {
  const input = { reelIds: ['reel-1'], evidenceIds: [] };
  const expectedOutput = {
    answer: 'I cannot verify that audio from the indexed evidence.',
    reelIds: [],
    evidenceIds: [],
    expectedEvidenceTypes: [],
    answerType: 'ABSTENTION',
  };
  const clean = {
    answer:
      'No relevant shared reel evidence is available in this conversation.',
    citations: [],
    retrievedEvidenceIds: [],
  };
  const cleanDeterministic = Object.fromEntries(
    deterministicEvaluations(input, expectedOutput, clean).map((score) => [
      score.name,
      score.value,
    ]),
  );
  assert.equal(cleanDeterministic.abstention_correct, 1);
  assert.equal(cleanDeterministic.reel_citation_match, 1);
  assert.equal(cleanDeterministic.modality_match, 1);
  assert(!('answer_exact_match' in cleanDeterministic));
  assert(!('answer_token_f1' in cleanDeterministic));
  assert(!('evidence_recall' in cleanDeterministic));
  const cleanStrict = Object.fromEntries(
    strictEvaluations(input, expectedOutput, clean).map((score) => [
      score.name,
      score.value,
    ]),
  );
  assert.equal(cleanStrict.citation_modality_precision, 1);
  assert(!('citation_source_recall' in cleanStrict));

  const unsupportedCitation = {
    ...clean,
    citations: [
      {
        reelId: 'reel-1',
        evidenceId: 'reel-1:chunk:0',
        evidenceType: 'TRANSCRIPT',
      },
    ],
  };
  const badDeterministic = deterministicEvaluations(
    input,
    expectedOutput,
    unsupportedCitation,
  );
  const badDeterministicByName = Object.fromEntries(
    badDeterministic.map((score) => [score.name, score.value]),
  );
  assert.equal(badDeterministicByName.abstention_correct, 0);
  assert.equal(badDeterministicByName.reel_citation_match, 0);
  const badStrict = Object.fromEntries(
    strictEvaluations(input, expectedOutput, unsupportedCitation).map(
      (score) => [score.name, score.value],
    ),
  );
  assert.equal(badStrict.citation_modality_precision, 0);
});

test('unknown execution health remains in the availability denominator', () => {
  const scores = Object.fromEntries(
    benchmarkEvaluations(
      {},
      {},
      { executionHealth: { status: 'UNKNOWN' } },
    ).map((score) => [score.name, score.value]),
  );
  assert.equal(scores.execution_health_available, 0);
});

test('clear abstention phrases are recognized without rewarding vague answers', () => {
  assert.equal(
    isClearAbstention('I cannot verify an audio sound from text.'),
    true,
  );
  assert.equal(
    isClearAbstention('No relevant shared reel evidence is available.'),
    true,
  );
  assert.equal(
    isClearAbstention(
      'The available shared Reel context does not contain enough audio evidence to identify the requested audio detail.',
    ),
    true,
  );
  assert.equal(isClearAbstention('The sound is a bell.'), false);
});
