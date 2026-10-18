import { SemanticIndexController } from './semantic-index.controller';

describe('SemanticIndexController versioned reindex', () => {
  const identity = {
    model: '@cf/baai/bge-m3',
    dimensions: 1024,
    version: 'cf-bge-m3-v1',
  };

  it('forwards a reindex only when the requested identity matches the worker', async () => {
    const content = {
      reindexReel: jest
        .fn()
        .mockResolvedValue({ queued: true, indexAttemptId: 'attempt-2' }),
    };
    const controller = new SemanticIndexController(
      {} as never,
      content as never,
      { embeddingIdentity: jest.fn(() => identity) } as never,
    );

    await expect(
      controller.reindexReel({
        reelId: 'reel-1',
        expectedEmbeddingIdentity: identity,
      }),
    ).resolves.toEqual({
      queued: true,
      indexAttemptId: 'attempt-2',
      embeddingIdentity: identity,
    });
    expect(content.reindexReel).toHaveBeenCalledWith('reel-1');
  });

  it('rejects a request for a different vector identity before queueing', async () => {
    const content = { reindexReel: jest.fn() };
    const controller = new SemanticIndexController(
      {} as never,
      content as never,
      { embeddingIdentity: jest.fn(() => identity) } as never,
    );

    await expect(
      controller.reindexReel({
        reelId: 'reel-1',
        expectedEmbeddingIdentity: { ...identity, dimensions: 384 },
      }),
    ).rejects.toThrow('does not match this worker');
    expect(content.reindexReel).not.toHaveBeenCalled();
  });

  it('forwards the visual evidence requirement for a visual reindex', async () => {
    const content = {
      reindexReel: jest
        .fn()
        .mockResolvedValue({ queued: true, indexAttemptId: 'attempt-3' }),
    };
    const controller = new SemanticIndexController(
      {} as never,
      content as never,
      { embeddingIdentity: jest.fn(() => identity) } as never,
    );

    await expect(
      controller.reindexReel({
        reelId: 'reel-1',
        expectedEmbeddingIdentity: identity,
        requireVisualAnalysis: true,
      }),
    ).resolves.toEqual({
      queued: true,
      indexAttemptId: 'attempt-3',
      embeddingIdentity: identity,
    });
    expect(content.reindexReel).toHaveBeenCalledWith('reel-1', {
      requireVisualAnalysis: true,
    });
  });
});
