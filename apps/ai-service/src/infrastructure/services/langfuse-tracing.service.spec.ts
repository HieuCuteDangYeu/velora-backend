import { startObservation } from '@langfuse/tracing';
import type { StructuredLlmCallDiagnostics } from '@ai/domain/interfaces/structured-llm.service.interface';
import { LangfuseTracingService } from './langfuse-tracing.service';

jest.mock('@langfuse/tracing', () => ({ startObservation: jest.fn() }));

describe('LangfuseTracingService semantic generations', () => {
  const previous = { ...process.env };

  const call = (
    overrides: Partial<StructuredLlmCallDiagnostics> = {},
  ): StructuredLlmCallDiagnostics => ({
    modelRole: 'ANSWER',
    model: 'openai/gpt-oss-120b',
    providerStatus: 200,
    latencyMs: 100,
    configuredTimeoutMs: 30_000,
    configuredMaxCompletionTokens: 512,
    attempt: 1,
    ...overrides,
  });

  beforeEach(() => {
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    jest.clearAllMocks();
    jest.mocked(startObservation).mockReturnValue({ end: jest.fn() } as never);
  });

  afterAll(() => {
    process.env = { ...previous };
  });

  it('uses canonical usage keys and keeps reasoning as diagnostic metadata', () => {
    new LangfuseTracingService().recordSemanticCalls([
      call({
        usage: {
          inputTokens: 2_200,
          outputTokens: 244,
          totalTokens: 2_444,
          reasoningTokens: 115,
        },
      }),
    ]);

    expect(startObservation).toHaveBeenCalledWith(
      'llm.answer',
      expect.objectContaining({
        usageDetails: { input: 2_200, output: 244, total: 2_444 },
        metadata: expect.objectContaining({ reasoningTokens: 115 }),
      }),
      expect.anything(),
    );
    const attributes = jest.mocked(startObservation).mock.calls[0]?.[1] as {
      usageDetails?: Record<string, number>;
    };
    expect(attributes.usageDetails).not.toHaveProperty('reasoning');
  });

  it('derives total only when both non-overlapping provider counts are known', () => {
    new LangfuseTracingService().recordSemanticCalls([
      call({ usage: { inputTokens: 2_200, outputTokens: 244 } }),
      call({ usage: { totalTokens: 7 } }),
    ]);

    expect(jest.mocked(startObservation).mock.calls[0][1]).toEqual(
      expect.objectContaining({
        usageDetails: { input: 2_200, output: 244, total: 2_444 },
      }),
    );
    expect(jest.mocked(startObservation).mock.calls[1][1]).toEqual(
      expect.objectContaining({ usageDetails: { total: 7 } }),
    );
  });

  it('leaves missing usage unknown instead of fabricating zero counts', () => {
    new LangfuseTracingService().recordSemanticCalls([
      call({ providerStatus: 'NETWORK_ERROR', usage: undefined }),
    ]);

    const attributes = jest.mocked(startObservation).mock.calls[0]?.[1] as {
      metadata?: Record<string, unknown>;
    };
    expect(attributes).not.toHaveProperty('usageDetails');
    expect(attributes.metadata).not.toHaveProperty('reasoningTokens');
  });

  it('records separate provider calls and retries independently', () => {
    new LangfuseTracingService().recordSemanticCalls([
      call({ attempt: 1, usage: { inputTokens: 10, outputTokens: 4 } }),
      call({
        attempt: 2,
        providerStatus: 429,
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 99 },
      }),
    ]);

    expect(startObservation).toHaveBeenCalledTimes(2);
    expect(
      jest
        .mocked(startObservation)
        .mock.calls.map(([, attributes]) => attributes),
    ).toEqual([
      expect.objectContaining({
        usageDetails: { input: 10, output: 4, total: 14 },
        metadata: expect.objectContaining({ attempt: '1' }),
      }),
      expect.objectContaining({
        usageDetails: { input: 12, output: 3, total: 99 },
        metadata: expect.objectContaining({ attempt: '2' }),
      }),
    ]);
  });
});
