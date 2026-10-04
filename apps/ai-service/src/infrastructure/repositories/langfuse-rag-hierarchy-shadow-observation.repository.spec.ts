import { startObservation } from '@langfuse/tracing';
import { maskLangfuseData } from '@ai/infrastructure/services/langfuse-telemetry';
import { LangfuseTracingService } from '@ai/infrastructure/services/langfuse-tracing.service';
import { LangfuseRagHierarchyShadowObservationRepository } from './langfuse-rag-hierarchy-shadow-observation.repository';

jest.mock('@langfuse/tracing', () => ({ startObservation: jest.fn() }));

describe('Langfuse hierarchy shadow observations', () => {
  const previous = { ...process.env };
  const value = {
    userId: 'user-1',
    conversationId: 'conversation-1',
    queryText: 'private query',
    retrievalMode: 'REEL_HYBRID' as const,
    requiredEvidence: ['TRANSCRIPT' as const],
    directChunkIds: Array.from({ length: 40 }, (_, i) => `direct-${i}`),
    hierarchicalChunkIds: ['hierarchy-1'],
    directMs: 10,
    hierarchicalMs: 20,
    overlapAtK: 0.5,
    jaccard: 0.25,
  };

  beforeEach(() => {
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_CAPTURE_CONTENT = 'false';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('records comparison metrics and complete source IDs without query text', async () => {
    const end = jest.fn();
    jest.mocked(startObservation).mockReturnValue({ end } as never);
    await new LangfuseRagHierarchyShadowObservationRepository(
      new LangfuseTracingService(),
    ).save(value);
    expect(startObservation).toHaveBeenCalledWith('rag.hierarchy-shadow', {
      output: expect.objectContaining({
        schemaVersion: 'rag-hierarchy-shadow-v1',
        conversationId: 'conversation-1',
        directCount: 40,
        hierarchicalCount: 1,
        directChunkIds: value.directChunkIds,
        directMs: 10,
        hierarchicalMs: 20,
        overlapAtK: 0.5,
        jaccard: 0.25,
      }),
    });
    expect(
      JSON.stringify(jest.mocked(startObservation).mock.calls),
    ).not.toContain('private query');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('retains bounded query text only under explicit content capture', async () => {
    process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
    jest.mocked(startObservation).mockReturnValue({ end: jest.fn() } as never);
    const queryText = 'synthetic evaluation query '.repeat(20);
    await new LangfuseRagHierarchyShadowObservationRepository(
      new LangfuseTracingService(),
    ).save({ ...value, queryText });
    const serialized = maskLangfuseData(
      JSON.stringify(jest.mocked(startObservation).mock.calls[0][1]),
    );
    expect(JSON.parse(serialized as string).output.query).toBe(queryText);
  });

  it('does not create an observation when tracing is disabled', async () => {
    process.env.LANGFUSE_ENABLED = 'false';
    await new LangfuseRagHierarchyShadowObservationRepository(
      new LangfuseTracingService(),
    ).save(value);
    expect(startObservation).not.toHaveBeenCalled();
  });
});
