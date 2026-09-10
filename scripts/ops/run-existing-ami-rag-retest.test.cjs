const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runner = require('./run-existing-ami-rag-retest.cjs');

const syntheticReelIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

function definitionsFor(reelIds = syntheticReelIds) {
  return {
    ragBenchmark: {
      cases: Array.from({ length: 8 }, (_, index) => ({
        caseId: `case-${index + 1}`,
        reelId: reelIds[index % reelIds.length],
      })),
    },
  };
}

const definitions = Array.from({ length: 8 }, (_, index) => ({
  caseId: `case-${index + 1}`,
}));
const stateFor = (statuses = {}) => ({
  cases: Object.fromEntries(
    definitions.map(({ caseId }) => [
      caseId,
      { status: statuses[caseId] || 'PENDING' },
    ]),
  ),
});

test('extracts four dataset-defined reel IDs without runtime UUID mappings', () => {
  assert.deepEqual(
    runner.extractDistinctReelIds(definitionsFor()),
    syntheticReelIds,
  );
  assert.deepEqual(
    runner.extractDistinctReelIds(
      definitionsFor([
        syntheticReelIds[0],
        syntheticReelIds[1],
        syntheticReelIds[1],
        syntheticReelIds[2],
        syntheticReelIds[3],
      ]),
    ),
    syntheticReelIds,
  );
});

test('accepts unrelated valid dataset UUIDs and rejects invalid definitions before network work', () => {
  const alternate = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ];
  assert.deepEqual(
    runner.extractDistinctReelIds(definitionsFor(alternate)),
    alternate,
  );
  assert.throws(
    () =>
      runner.extractDistinctReelIds(
        definitionsFor(['not-a-uuid', ...syntheticReelIds.slice(1)]),
      ),
    /invalid reel UUID/,
  );
  assert.throws(
    () => runner.extractDistinctReelIds({ ragBenchmark: { cases: [] } }),
    /exactly eight/,
  );
  assert.throws(
    () =>
      runner.extractDistinctReelIds(
        definitionsFor(syntheticReelIds.slice(0, 3)),
      ),
    /exactly four distinct/,
  );
});

test('generic runner has no dependency on obsolete v1 UUID constants', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'run-existing-ami-rag-retest.cjs'),
    'utf8',
  );
  for (const obsolete of [
    '9f5ed300-8b47-4715-a23f-d5082987ff43',
    'f9f57d92-7edf-4cc7-993a-24302bc3858b',
    '944c9e59-cc47-412c-aece-f378cf758d66',
    '487ebc29-697c-406c-8990-6d7a264c2c3c',
  ]) {
    assert.equal(source.includes(obsolete), false);
  }
});

test('fresh eight cases transition through persisted in-flight state exactly once', () => {
  const state = stateFor();
  const calls = [];
  for (const definition of runner.pendingCases(state, definitions)) {
    runner.markCaseInFlight(state, definition.caseId, () => {
      assert.equal(state.cases[definition.caseId].status, 'IN_FLIGHT');
    });
    calls.push(definition.caseId);
    runner.completeCase(
      state,
      definition.caseId,
      { result: { caseId: definition.caseId } },
      () => {},
    );
  }
  assert.deepEqual(
    calls,
    definitions.map(({ caseId }) => caseId),
  );
  assert.deepEqual(runner.formatStatus('fresh', state).counts, {
    PENDING: 0,
    IN_FLIGHT: 0,
    COMPLETED: 8,
    FAILED: 0,
    FAILED_RECONCILED: 0,
  });
});

test('resume skips completed cases and executes only the remaining six', () => {
  const state = stateFor({ 'case-1': 'COMPLETED', 'case-2': 'COMPLETED' });
  assert.deepEqual(
    runner.pendingCases(state, definitions).map(({ caseId }) => caseId),
    definitions.slice(2).map(({ caseId }) => caseId),
  );
});

test('completed resume is zero-write and ambiguous in-flight fails before replay', () => {
  const completed = stateFor(
    Object.fromEntries(definitions.map(({ caseId }) => [caseId, 'COMPLETED'])),
  );
  assert.equal(runner.pendingCases(completed, definitions).length, 0);
  const ambiguous = stateFor({ 'case-2': 'IN_FLIGHT' });
  assert.throws(() => runner.pendingCases(ambiguous, definitions), /IN_FLIGHT/);
  assert.equal(ambiguous.cases['case-2'].status, 'IN_FLIGHT');
});

test('different run IDs have independent locks', () => {
  const one = `test-a-${Date.now()}-${Math.random()}`;
  const two = `test-b-${Date.now()}-${Math.random()}`;
  const releaseOne = runner.lockRun(one);
  const releaseTwo = runner.lockRun(two);
  releaseTwo();
  releaseOne();
});

test('status format is read-only and warns for ambiguous in-flight work', () => {
  const output = runner.formatStatus('run-a', {
    cases: { one: { status: 'COMPLETED' }, two: { status: 'IN_FLIGHT' } },
  });
  assert.equal(output.benchmarkRunId, 'run-a');
  assert.equal(output.counts.COMPLETED, 1);
  assert.equal(output.counts.IN_FLIGHT, 1);
  assert.match(output.warning, /DO NOT RESEND/);
});

test('atomic write leaves a parseable canonical state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ami-runner-'));
  const file = path.join(directory, 'state.json');
  runner.writeJsonAtomically(file, { cases: { one: { status: 'IN_FLIGHT' } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    cases: { one: { status: 'IN_FLIGHT' } },
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('same-run lock refuses a second owner before execution', () => {
  const runId = `test-${Date.now()}-${Math.random()}`;
  const release = runner.lockRun(runId);
  assert.throws(() => runner.lockRun(runId), /already locked/);
  release();
});

test('failed executor remains in-flight and is never marked completed', () => {
  const state = stateFor();
  runner.markCaseInFlight(state, 'case-1', () => {});
  assert.equal(state.cases['case-1'].status, 'IN_FLIGHT');
  assert.notEqual(state.cases['case-1'].status, 'COMPLETED');
});

test('reconciled failure becomes a report row without an assistant identifier', () => {
  assert.deepEqual(
    runner.reconciledResult(
      { caseId: 'case-1', reelId: syntheticReelIds[0] },
      {
        status: 'FAILED_RECONCILED',
        conversationId: 'conversation-1',
        userMessageId: 'request-1',
        reconciledAt: '2026-08-25T00:05:00.000Z',
        reconciliationReason: 'WORKFLOW_ENDED_WITHOUT_BOT_RESPONSE',
      },
    ),
    {
      caseId: 'case-1',
      reelId: syntheticReelIds[0],
      status: 'FAILED_RECONCILED',
      conversationId: 'conversation-1',
      userMessageId: 'request-1',
      reconciledAt: '2026-08-25T00:05:00.000Z',
      latencyMs: null,
      finalAnswer: '',
      citations: [],
      reconciliationReason: 'WORKFLOW_ENDED_WITHOUT_BOT_RESPONSE',
    },
  );
});

test('response-present reconciliation records the bot result without resending', () => {
  const definition = {
    caseId: 'case-1',
    reelId: syntheticReelIds[0],
    question: 'What happened?',
    referenceAnswerText: 'A response.',
  };
  const result = runner.responseReconciledResult(
    definition,
    {
      status: 'IN_FLIGHT',
      conversationId: 'conversation-1',
      userMessageId: 'request-1',
      requestStartedAt: '2026-08-25T00:00:00.000Z',
    },
    {
      id: 'assistant-1',
      createdAt: '2026-08-25T00:01:00.000Z',
      content: 'A response.',
      metadata: { citations: [{ reelId: syntheticReelIds[0] }] },
    },
    syntheticReelIds,
    'run-1',
  );
  assert.deepEqual(
    {
      status: result.status,
      conversationId: result.conversationId,
      accessibleReelIds: result.accessibleReelIds,
      userMessageId: result.userMessageId,
      assistantMessageId: result.assistantMessageId,
      latencyMs: result.latencyMs,
      finalAnswer: result.finalAnswer,
      citations: result.citations,
    },
    {
      status: 'EVALUATED',
      conversationId: 'conversation-1',
      accessibleReelIds: syntheticReelIds,
      userMessageId: 'request-1',
      assistantMessageId: 'assistant-1',
      latencyMs: 60_000,
      finalAnswer: 'A response.',
      citations: [{ reelId: syntheticReelIds[0] }],
    },
  );
});

test('reconciliation records objective no-resend evidence after the quiet period', () => {
  const evidence = runner.buildReconciliationEvidence({
    runLockAcquired: true,
    progress: { status: 'IN_FLIGHT' },
    primaryMessages: [{ id: 'request-1' }],
    botMessages: [],
    traces: [{ createdAt: '2026-08-25T00:00:00.000Z', hasAnswer: false }],
    nowMs: Date.parse('2026-08-25T00:05:00.000Z'),
    minimumQuietMs: 120_000,
  });
  assert.deepEqual(evidence, {
    primaryRequestCount: 1,
    botResponseCount: 0,
    traceEvidenceCount: 1,
    latestTraceAt: '2026-08-25T00:00:00.000Z',
    activeRunLockBeforeReconciliation: false,
    workflowTerminalEvidence: 'RAG_TRACE_PERSISTED_AFTER_GRAPH_EXIT',
  });
});

test('response-present reconciliation accepts one quiet bot response with trace evidence', () => {
  const evidence = runner.buildResponseReconciliationEvidence({
    runLockAcquired: true,
    progress: { status: 'IN_FLIGHT' },
    primaryMessages: [{ id: 'request-1' }],
    botMessages: [
      {
        id: 'assistant-1',
        createdAt: '2026-08-25T00:02:00.000Z',
        content: 'answer',
      },
    ],
    traces: [{ createdAt: '2026-08-25T00:01:00.000Z', hasAnswer: true }],
    nowMs: Date.parse('2026-08-25T00:05:00.000Z'),
    minimumQuietMs: 120_000,
  });
  assert.deepEqual(evidence, {
    primaryRequestCount: 1,
    botResponseCount: 1,
    traceEvidenceCount: 1,
    latestTraceAt: '2026-08-25T00:01:00.000Z',
    latestBotResponseAt: '2026-08-25T00:02:00.000Z',
    activeRunLockBeforeReconciliation: false,
    workflowTerminalEvidence: 'BOT_RESPONSE_AND_RAG_TRACE_PERSISTED',
    assistantMessageId: 'assistant-1',
  });
});

test('reconciliation refuses a bot response, duplicate request, or active quiet period', () => {
  const base = {
    runLockAcquired: true,
    progress: { status: 'IN_FLIGHT' },
    primaryMessages: [{ id: 'request-1' }],
    botMessages: [],
    traces: [{ createdAt: '2026-08-25T00:00:00.000Z', hasAnswer: false }],
    nowMs: Date.parse('2026-08-25T00:05:00.000Z'),
    minimumQuietMs: 120_000,
  };
  assert.throws(
    () => runner.buildReconciliationEvidence({ ...base, botMessages: [{}] }),
    /bot response exists/,
  );
  assert.throws(
    () =>
      runner.buildReconciliationEvidence({
        ...base,
        primaryMessages: [{}, {}],
      }),
    /exactly one primary request/,
  );
  assert.throws(
    () =>
      runner.buildReconciliationEvidence({
        ...base,
        nowMs: Date.parse('2026-08-25T00:01:00.000Z'),
      }),
    /quiet period/,
  );
  assert.throws(
    () =>
      runner.buildReconciliationEvidence({
        ...base,
        runLockAcquired: false,
      }),
    /exclusive benchmark run lock/,
  );
});

test('reconciliation normalizes the Mongo pool option without changing credentials', () => {
  const normalized = new URL(
    runner.normalizeMongoConnectionUrl(
      'mongodb+srv://user:pass@example.test/db?connection_limit=1',
    ),
  );
  assert.equal(normalized.username, 'user');
  assert.equal(normalized.password, 'pass');
  assert.equal(normalized.searchParams.has('connection_limit'), false);
  assert.equal(normalized.searchParams.get('maxPoolSize'), '1');
});
