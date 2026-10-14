import { ContentRepository } from './content.repository';

describe('ContentRepository reel deletion', () => {
  it('renumbers remaining series episodes after deleting a reel', async () => {
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
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
      toMediaMetadataData: jest.fn().mockReturnValue({}),
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
        findUnique: jest.fn().mockResolvedValue({
          id: 'reel-1',
          sourceDurationMs: null,
          outputDurationMs: null,
          sourceWidth: null,
          sourceHeight: null,
          sourceFps: null,
          sourceBitrateKbps: null,
          sourceHasAudio: null,
          sourceRotation: null,
          sourceOrientation: null,
          sourceLengthClass: null,
          sourceAspectRatio: null,
          sourceEffectiveWidth: null,
          sourceEffectiveHeight: null,
          encodedVariantCount: null,
          encodedMaxHeight: null,
          encodedFps: null,
        }),
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

  it.each([
    'MEDIA_READY',
    'LOADING_EXISTING_HLS',
    'BUILDING_AUDIO_MANIFEST',
    'BUILDING_VISUAL_MANIFEST',
    'RETRY_SCHEDULED',
  ])('accepts evidence completion after %s', async (processingStage) => {
    const outboxCreate = jest.fn().mockResolvedValue({});
    const transaction = {
      reel: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reel-1',
          mediaStatus: 'COMPLETED',
          indexStatus: 'PENDING',
          processingStage,
          sourceDurationMs: 120_000,
          outputDurationMs: 120_000,
          sourceWidth: 1_920,
          sourceHasAudio: true,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'reel-1',
          userId: 'user-1',
          mediaKey: 'reels/user-1/source.mp4',
          indexAttemptId: 'index-attempt-1',
          sourceDurationMs: 120_000,
          outputDurationMs: 120_000,
          sourceHasAudio: true,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
          title: 'Test reel',
          description: null,
          tags: [],
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
      toMediaMetadataData: jest.fn().mockReturnValue({
        sourceDurationMs: 1,
        sourceWidth: 1,
      }),
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.completeExistingHlsEvidence.call(repository, {
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        transcriptionAudioManifestKey: 'reels/user-1/audio.json',
        visualFrameManifestKey: 'reels/user-1/visual.json',
        mediaMetadata: {
          sourceDurationMs: 120_000,
          sourceHasAudio: true,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
        },
      }),
    ).resolves.toBe(true);
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(
      transaction.reel.updateMany.mock.calls[0][0].data,
    ).not.toHaveProperty('sourceWidth');
    expect(outboxCreate.mock.calls[0][0].data.payload.sourceDurationMs).toBe(
      120_000,
    );
  });
});

describe('ContentRepository early Reel media readiness', () => {
  it('commits playback fields and queues exactly one durable evidence job', async () => {
    const outboxCreate = jest.fn().mockResolvedValue({});
    const transaction = {
      reel: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'reel-1',
          userId: 'user-1',
          mediaKey: 'reels/user-1/source.mp4',
          indexAttemptId: 'index-attempt-1',
          title: 'Test reel',
          description: null,
          tags: [],
        }),
      },
      reelMediaAttemptLease: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      outboxEvent: { create: outboxCreate },
    };
    const repository = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
      toMediaMetadataData: jest.fn().mockReturnValue({}),
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.completeMediaProcessing.call(repository, {
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        mediaMetadata: {
          sourceDurationMs: 120_000,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
        },
        mediaOutput: {
          hlsMasterKey: 'reels/user-1/attempt-1/master.m3u8',
          thumbnailKey: 'reels/user-1/attempt-1/thumbnail.jpg',
          sourceHasAudio: true,
          sourceLengthClass: 'SHORT',
          variants: [],
          hlsObjectCount: 4,
          hlsTotalBytes: 100,
          checksums: {
            sourceSha256: 'source',
            hlsMasterSha256: 'hls',
            thumbnailSha256: 'thumb',
          },
        },
      }),
    ).resolves.toBe(true);

    expect(outboxCreate).toHaveBeenCalledTimes(1);
    const event = outboxCreate.mock.calls[0][0].data;
    expect(event.eventType).toBe('reel.media.requested.v1');
    expect(event.payload.sourceMode).toBe('EXISTING_HLS');
    expect(event.payload.hlsMasterKey).toBe(
      'reels/user-1/attempt-1/master.m3u8',
    );
    expect(event.payload).not.toHaveProperty('transcriptionAudioManifestKey');
  });

  it('does not emit a second evidence job for a stale duplicate completion', async () => {
    const outboxCreate = jest.fn().mockResolvedValue({});
    const transaction = {
      reel: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn(),
      },
      outboxEvent: { create: outboxCreate },
    };
    const repository = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
      toMediaMetadataData: jest.fn().mockReturnValue({}),
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.completeMediaProcessing.call(repository, {
        reelId: 'reel-1',
        mediaAttemptId: 'stale-attempt',
        mediaMetadata: {
          sourceDurationMs: 120_000,
          sourceOrientation: 'PORTRAIT',
        },
        mediaOutput: {
          hlsMasterKey: 'reels/user-1/stale/master.m3u8',
          thumbnailKey: 'reels/user-1/stale/thumbnail.jpg',
          sourceHasAudio: false,
          sourceLengthClass: 'SHORT',
          variants: [],
          hlsObjectCount: 1,
          hlsTotalBytes: 1,
          checksums: {
            sourceSha256: 'source',
            hlsMasterSha256: 'hls',
            thumbnailSha256: 'thumb',
          },
        },
      }),
    ).resolves.toBe(false);
    expect(outboxCreate).not.toHaveBeenCalled();
  });
});

describe('ContentRepository late media event fences', () => {
  it('ignores a source failure after media completion has advanced to readiness', async () => {
    const currentRecord = {
      id: 'reel-1',
      userId: 'user-1',
      mediaStatus: 'COMPLETED',
      indexStatus: 'PENDING',
      processingStage: 'MEDIA_READY',
      mediaAttemptId: 'attempt-1',
      tags: [],
      viewCount: BigInt(0),
    };
    const updateMany = jest.fn();
    const repository = {
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback({
          reel: {
            findUnique: jest.fn().mockResolvedValue(currentRecord),
            updateMany,
            findUniqueOrThrow: jest.fn().mockResolvedValue(currentRecord),
          },
        }),
      ),
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as ContentRepository;

    const result = await ContentRepository.prototype.updateReelStatus.call(
      repository,
      'reel-1',
      'FAILED',
      undefined,
      undefined,
      undefined,
      undefined,
      'FAILED',
      'source response lost',
      90,
      undefined,
      undefined,
      undefined,
      'attempt-1',
      'PROCESSING_COMPLETED_HANDLER_FAILED',
      'source response lost',
      undefined,
      'SOURCE_VIDEO',
    );

    expect(result.mediaStatus).toBe('COMPLETED');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    'LOADING_EXISTING_HLS',
    'BUILDING_AUDIO_MANIFEST',
    'BUILDING_VISUAL_MANIFEST',
    'RETRY_SCHEDULED',
  ])('reclaims an evidence attempt after %s', async (processingStage) => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const repository = {
      reel: { updateMany },
      reelMediaAttemptLease: { updateMany: jest.fn().mockResolvedValue({}) },
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.claimProcessingAttempt.call(repository, {
        reelId: 'reel-1',
        processingAttemptId: 'attempt-1',
        evidenceOnly: true,
        allowReclaim: true,
      }),
    ).resolves.toBe(true);

    expect(updateMany.mock.calls[0][0].where.processingStage.in).toContain(
      processingStage,
    );
  });
  it('binds an evidence claim to the canonical owner and HLS key', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const repository = { reel: { updateMany } } as unknown as ContentRepository;
    await expect(
      ContentRepository.prototype.claimProcessingAttempt.call(repository, {
        reelId: 'reel-1',
        processingAttemptId: 'attempt-1',
        evidenceOnly: true,
        userId: 'owner-1',
        hlsMasterKey: 'reels/reel-1/master.m3u8',
      }),
    ).resolves.toBe(false);
    expect(updateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        id: 'reel-1',
        mediaAttemptId: 'attempt-1',
        userId: 'owner-1',
        hlsMasterKey: 'reels/reel-1/master.m3u8',
        mediaStatus: 'COMPLETED',
      }),
    );
  });
});
