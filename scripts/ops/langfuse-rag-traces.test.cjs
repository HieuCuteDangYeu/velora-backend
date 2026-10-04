const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadLangfuseRagTraces,
  monitoringSnapshot,
} = require('./langfuse-rag-traces.cjs');
const { buildTraceRows } = require('./export-rag-traces.cjs');

function observation(id = 'root-1', traceId = 'trace-1') {
  return {
    id,
    traceId,
    sessionId: 'conversation-1',
    startTime: '2026-10-03T00:00:00Z',
    endTime: '2026-10-03T00:00:01Z',
    output: JSON.stringify({
      schemaVersion: 'rag-monitoring-v1',
      ragTrace: {
        conversationId: 'conversation-1',
        retrievedChunkIds: ['reel:r1:chunk:0'],
        rerankedChunkIds: [],
        workflowMetrics: {
          retrievalRetryCount: 0,
          answerRetryCount: 0,
          citationRetryCount: 0,
          diagnostics: {
            productionExecutionId: 'execution-1',
            langfuseTraceId: traceId,
          },
        },
      },
    }),
  };
}

test('paginates workflow observations and exports the real Langfuse trace ID', async () => {
  const requests = [];
  const pages = [
    { data: [observation()], meta: { cursor: 'next' } },
    { data: [], meta: {} },
  ];
  const client = {
    api: {
      observations: {
        getMany: async (request) => {
          requests.push(request);
          return pages.shift();
        },
      },
    },
  };
  const traces = await loadLangfuseRagTraces(client, {
    sessionId: 'conversation-1',
  });
  assert.equal(requests[1].cursor, 'next');
  assert.equal(requests[0].name, 'rag.workflow');
  const rows = buildTraceRows(
    [
      {
        caseId: 'case-1',
        conversationId: 'conversation-1',
        userMessageId: 'u',
        assistantMessageId: 'a',
      },
    ],
    traces,
  );
  assert.equal(rows[0].traceId, 'trace-1');
  assert.deepEqual(rows[0].retrievedChunkIds, ['reel:r1:chunk:0']);
});

test('rejects missing snapshots, unfinished observations and mismatched correlation', () => {
  for (const change of [
    { output: '[REDACTED]' },
    { endTime: null },
    { sessionId: 'other' },
    { traceId: 'other' },
  ]) {
    assert.throws(
      () => monitoringSnapshot({ ...observation(), ...change }),
      /TRACE_PROVENANCE=INCOMPLETE/,
    );
  }
});

test('rejects repeated pagination cursors and observations', async () => {
  const client = {
    api: {
      observations: {
        getMany: async () => ({ data: [], meta: { cursor: 'same' } }),
      },
    },
  };
  await assert.rejects(
    loadLangfuseRagTraces(client),
    /repeated Langfuse cursor/,
  );
  client.api.observations.getMany = async () => ({
    data: [observation(), observation()],
    meta: {},
  });
  await assert.rejects(
    loadLangfuseRagTraces(client),
    /TRACE_PROVENANCE=AMBIGUOUS/,
  );
});

test('does not collapse multiple workflow roots into one apparent execution', async () => {
  const client = {
    api: {
      observations: {
        getMany: async () => ({
          data: [observation(), observation('root-2', 'trace-2')],
          meta: {},
        }),
      },
    },
  };
  const traces = await loadLangfuseRagTraces(client);
  assert.throws(
    () =>
      buildTraceRows(
        [
          {
            caseId: 'case-1',
            conversationId: 'conversation-1',
            userMessageId: 'u',
            assistantMessageId: 'a',
          },
        ],
        traces,
      ),
    /TRACE_PROVENANCE=AMBIGUOUS/,
  );
});

test('reads paginated hierarchy metrics and rejects incomplete comparison provenance', async () => {
  const {
    loadLangfuseHierarchyShadowObservations,
    hierarchyShadowSnapshot,
  } = require('./langfuse-rag-traces.cjs');
  const value = {
    ...observation(),
    name: 'rag.hierarchy-shadow',
    output: JSON.stringify({
      schemaVersion: 'rag-hierarchy-shadow-v1',
      conversationId: 'conversation-1',
      directMs: 10,
      hierarchicalMs: 20,
      overlapAtK: 0.5,
      jaccard: 0.25,
    }),
  };
  const requests = [];
  const client = {
    api: {
      observations: {
        getMany: (request) => {
          requests.push(request);
          return Promise.resolve({ data: [value], meta: {} });
        },
      },
    },
  };
  const rows = await loadLangfuseHierarchyShadowObservations(client, {
    environment: 'production',
  });
  assert.equal(requests[0].name, 'rag.hierarchy-shadow');
  assert.equal(requests[0].environment, 'production');
  assert.equal(rows[0].directMs, 10);
  assert.equal(rows[0].jaccard, 0.25);
  assert.throws(
    () => hierarchyShadowSnapshot({ ...value, sessionId: 'other' }),
    /TRACE_PROVENANCE=INCOMPLETE/,
  );
  assert.throws(
    () =>
      hierarchyShadowSnapshot({
        ...value,
        output: JSON.stringify({
          schemaVersion: 'rag-hierarchy-shadow-v1',
          conversationId: 'conversation-1',
        }),
      }),
    /TRACE_PROVENANCE=INCOMPLETE/,
  );
});
