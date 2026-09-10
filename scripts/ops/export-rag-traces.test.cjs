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

test('accepts one trace for a reconciled failure without an assistant identifier', () => {
  const rows = buildTraceRows(
    [
      {
        caseId: 'C-RECONCILED',
        status: 'FAILED_RECONCILED',
        conversationId: 'conversation-1',
        userMessageId: 'user-message-1',
      },
    ],
    [
      {
        id: 'trace-1',
        conversationId: 'conversation-1',
        workflowMetrics: { diagnostics: { finalFailureSource: 'NO_CONTEXT' } },
      },
    ],
  );

  assert.equal(rows[0].caseId, 'C-RECONCILED');
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

test('retains safe answer and finalization diagnostics without private text', () => {
  const output = JSON.stringify(
    sanitize({
      answer: 'private answer',
      answerCalls: [
        {
          modelRole: 'ANSWER',
          providerStatus: 200,
          attempt: 1,
          prompt: 'private prompt',
        },
      ],
      finalization: {
        draftAnswerExecuted: true,
        draftAnswerProviderStatus: 200,
        verifierDecision: 'PASS',
        answerRevisionExecuted: false,
        finalSource: 'ANSWER',
        finalFailureSource: 'NONE',
      },
    }),
  );

  assert.match(output, /answerCalls/);
  assert.match(output, /draftAnswerExecuted/);
  assert.match(output, /answerRevisionExecuted/);
  assert.match(output, /verifierDecision/);
  assert.match(output, /finalSource/);
  assert.doesNotMatch(output, /private answer|private prompt/);
});

test('retains context sufficiency diagnostics without private text', () => {
  const output = JSON.stringify(
    sanitize({
      contextSufficiency: {
        providerStatus: 'SUCCESS',
        decisionSource: 'LLM',
        sufficient: false,
        availableEvidence: ['TRANSCRIPT'],
        missingEvidence: ['TRANSCRIPT'],
        recommendedAction: 'REFUSE_NO_CONTEXT',
        supportedEvidenceIds: ['e0'],
        reason: 'private evidence reasoning',
        semanticCalls: [
          {
            modelRole: 'CONTEXT_SUFFICIENCY',
            providerStatus: 200,
            attempt: 1,
          },
        ],
      },
    }),
  );

  assert.match(output, /contextSufficiency/);
  assert.match(output, /CONTEXT_SUFFICIENCY/);
  assert.match(output, /supportedEvidenceIds/);
  assert.match(output, /availableEvidence/);
  assert.match(output, /missingEvidence/);
  assert.match(output, /REFUSE_NO_CONTEXT/);
  assert.doesNotMatch(output, /private evidence reasoning/);
});
