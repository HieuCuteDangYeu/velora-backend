const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTraceRows, sanitize } = require('./export-rag-traces.cjs');

const cases = [
  {
    caseId: 'C-1',
    conversationId: 'conversation-1',
    userMessageId: 'user-message-1',
    assistantMessageId: 'assistant-message-1',
  },
];

test('requires exactly one matching trace', () => {
  assert.throws(() => buildTraceRows(cases, []), /TRACE_PROVENANCE=MISSING/);
  assert.throws(
    () =>
      buildTraceRows(cases, [
        { id: 'trace-1', conversationId: 'conversation-1' },
        { id: 'trace-2', conversationId: 'conversation-1' },
      ]),
    /TRACE_PROVENANCE=AMBIGUOUS/,
  );
  const rows = buildTraceRows(cases, [
    {
      id: 'trace-1',
      conversationId: 'conversation-1',
      retrievedChunkIds: ['reel:r1:chunk:0'],
      workflowMetrics: {
        diagnostics: { routeDecision: { intent: 'REEL_VIDEO_QUESTION' } },
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].traceId, 'trace-1');
});

test('sanitizes private fields while retaining safe IDs and diagnostics', () => {
  const output = JSON.stringify(
    sanitize({
      evidenceIds: ['reel:r1:chunk:0'],
      providerStatus: 429,
      modelRole: 'CITATION_ATTRIBUTION',
      answer: 'private answer',
      prompt: 'private prompt',
      quote: 'private evidence',
      requestId: 'private-request-id',
    }),
  );
  assert.match(output, /reel:r1:chunk:0/);
  assert.match(output, /CITATION_ATTRIBUTION/);
  assert.doesNotMatch(
    output,
    /private answer|private prompt|private evidence|private-request-id/,
  );
});
