import { ContentRepository } from './content.repository';

describe('ContentRepository reel deletion', () => {
  it('renumbers remaining series episodes after deleting a reel', async () => {
    const transaction = {
      reel: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'reel-2', seriesId: 'series-1' }),
        delete: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'reel-1' }, { id: 'reel-3' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const repository = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.deleteReel.call(
        repository,
        'reel-2',
        'user-1',
      ),
    ).resolves.toBe(true);

    expect(transaction.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-1' },
      data: { episodeNumber: 1 },
    });
    expect(transaction.reel.update).toHaveBeenCalledWith({
      where: { id: 'reel-3' },
      data: { episodeNumber: 2 },
    });
    expect(
      (repository as any).recommendationFeedCacheRepository.invalidateReels,
    ).toHaveBeenCalledWith(['reel-2']);
  });
});

describe('ContentRepository existing HLS evidence indexing', () => {
  it('does not force visual analysis for backlog indexing jobs', async () => {
    const outboxCreate = jest.fn().mockResolvedValue({});
    const transaction = {
      reel: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'reel-1',
          userId: 'user-1',
          mediaKey: 'reels/reel-1/source.mp4',
          indexAttemptId: 'index-attempt-1',
          title: 'Test reel',
          description: 'Test description',
          tags: ['test'],
        }),
      },
      outboxEvent: { create: outboxCreate },
    };
    const repository = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      configService: { get: jest.fn().mockReturnValue('reel-index-v2') },
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
      toMediaMetadataData: jest.fn().mockReturnValue({}),
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.completeExistingHlsEvidence.call(repository, {
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        transcriptionAudioManifestKey: 'reels/reel-1/audio/manifest.json',
        visualFrameManifestKey: 'reels/reel-1/visual/manifest.json',
        mediaMetadata: {
          sourceDurationMs: 120_000,
          sourceHasAudio: true,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
        },
      }),
    ).resolves.toBe(true);

    expect(outboxCreate).toHaveBeenCalledTimes(1);
    const payload = outboxCreate.mock.calls[0][0].data.payload as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('requireVisualAnalysis');
  });
});
