import {
  createLangfuseSdk,
  langfuseEnabled,
  redactLangfuseValue,
  maskLangfuseData,
  sanitizeRagSnapshot,
} from './langfuse-telemetry';
import { LangfuseTracingService } from './langfuse-tracing.service';

describe('Langfuse telemetry', () => {
  it('masks serialized SDK attributes without discarding structured diagnostics', () => {
    const masked = maskLangfuseData(
      JSON.stringify({
        ragTrace: sanitizeRagSnapshot({
          message: 'private question',
          answer: 'private answer',
          retrievedChunkIds: Array.from({ length: 40 }, (_, i) => `chunk-${i}`),
          workflowMetrics: {
            answerRetryCount: 1,
            diagnostics: {
              productionExecutionId: 'execution-1',
              retrievalPlanActual: {
                query: 'private query',
                mode: 'REEL_HYBRID',
              },
              answerCalls: [
                {
                  modelRole: 'ANSWER',
                  providerStatus: 200,
                  requestId: 'private-id',
                },
              ],
            },
          },
        }),
      }),
    );
    expect(typeof masked).toBe('string');
    const snapshot = JSON.parse(masked as string).ragTrace;
    expect(snapshot.retrievedChunkIds).toHaveLength(40);
    expect(snapshot.workflowMetrics.diagnostics).toMatchObject({
      productionExecutionId: 'execution-1',
      retrievalPlanActual: { mode: 'REEL_HYBRID' },
      answerCalls: [{ modelRole: 'ANSWER', providerStatus: 200 }],
    });
    expect(masked).not.toMatch(/private/);
  });

  it.each([false, true])(
    'preserves exact evaluation evidence only with capture opt-in: %s',
    (capture) => {
      const previous = process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT;
      process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = String(capture);
      try {
        const masked = maskLangfuseData(
          JSON.stringify({
            ragTrace: sanitizeRagSnapshot({
              generationEvidence: [
                {
                  sourceId: 'chunk-1',
                  evidenceText: 'private evidence'.repeat(30),
                  requestId: 'private-id',
                },
              ],
            }),
          }),
        );
        const evidence = JSON.parse(masked as string).ragTrace
          .generationEvidence;
        if (capture)
          expect(evidence).toEqual([
            {
              sourceId: 'chunk-1',
              evidenceText: 'private evidence'.repeat(30),
            },
          ]);
        else expect(evidence).toBeUndefined();
        expect(masked).not.toContain('private-id');
      } finally {
        if (previous === undefined)
          delete process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT;
        else process.env.AI_RAG_CAPTURE_EVALUATION_CONTEXT = previous;
      }
    },
  );

  it('requires explicit enablement and both remote credentials', () => {
    expect(
      langfuseEnabled({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
      }),
    ).toBe(true);
    expect(
      langfuseEnabled({ LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk' }),
    ).toBe(false);
    expect(
      createLangfuseSdk({
        LANGFUSE_ENABLED: 'false',
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
      }),
    ).toBeUndefined();
  });

  it('redacts prompt and context fields while retaining safe metadata', () => {
    expect(
      redactLangfuseValue({
        prompt: 'private prompt',
        context: 'full transcript',
        providerStatus: 'SUCCESS',
        latencyMs: 12,
      }),
    ).toEqual({
      prompt: '[REDACTED]',
      context: '[REDACTED]',
      providerStatus: 'SUCCESS',
      latencyMs: 12,
    });
  });

  it('creates a correlation root without making a provider call', async () => {
    const previous = {
      enabled: process.env.LANGFUSE_ENABLED,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
    };
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    try {
      const tracing = new LangfuseTracingService();
      await expect(
        tracing.withRoot(
          {
            productionExecutionId: 'production-execution-1',
            userId: 'user-1',
            conversationId: 'conversation-1',
          },
          (root) => {
            tracing.setRootOutput(root, {
              ragTraceId: 'rag-trace-1',
              status: 'SUCCEEDED',
            });
            return Promise.resolve('ok');
          },
        ),
      ).resolves.toBe('ok');
    } finally {
      if (previous.enabled === undefined) delete process.env.LANGFUSE_ENABLED;
      else process.env.LANGFUSE_ENABLED = previous.enabled;
      if (previous.publicKey === undefined)
        delete process.env.LANGFUSE_PUBLIC_KEY;
      else process.env.LANGFUSE_PUBLIC_KEY = previous.publicKey;
      if (previous.secretKey === undefined)
        delete process.env.LANGFUSE_SECRET_KEY;
      else process.env.LANGFUSE_SECRET_KEY = previous.secretKey;
    }
  });
});
