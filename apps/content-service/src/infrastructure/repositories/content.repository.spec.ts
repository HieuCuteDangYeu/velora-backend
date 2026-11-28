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

  it('upgrades sourceHasAudio from false to true when verified audio evidence is provided', async () => {
    const outboxCreate = jest.fn().mockResolvedValue({});
    const transaction = {
      reel: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'reel-1',
          mediaStatus: 'COMPLETED',
          indexStatus: 'PENDING',
          sourceHasAudio: false,
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'reel-1',
          userId: 'user-1',
          mediaKey: 'reels/user-1/source.mp4',
          indexAttemptId: 'index-attempt-1',
          sourceDurationMs: 60_000,
          outputDurationMs: 60_000,
          sourceHasAudio: false,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
          title: 'Imported reel',
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
        sourceHasAudio: true,
      }),
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.completeExistingHlsEvidence.call(repository, {
        reelId: 'reel-1',
        mediaAttemptId: 'media-attempt-1',
        transcriptionAudioManifestKey: 'reels/user-1/audio/manifest.json',
        visualFrameManifestKey: 'reels/user-1/visual/manifest.json',
        mediaMetadata: {
          sourceDurationMs: 60_000,
          sourceHasAudio: true,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
        },
      }),
    ).resolves.toBe(true);

    expect(
      transaction.reel.updateMany.mock.calls[0][0].data.sourceHasAudio,
    ).toBe(true);
    expect(outboxCreate.mock.calls[0][0].data.payload.sourceHasAudio).toBe(
      true,
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

  it('delays the fallback evidence job when the media worker builds the evidence itself', async () => {
    const outboxCreate = jest.fn().mockResolvedValue({});
    const transaction = {
      reel: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'reel-1',
          userId: 'user-1',
          mediaKey: 'reels/user-1/source.mp4',
          indexAttemptId: 'index-attempt-1',
          title: null,
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
      getInlineEvidenceFallbackDelayMs: () => 600_000,
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
      toMediaMetadataData: jest.fn().mockReturnValue({}),
    } as unknown as ContentRepository;
    const output = (evidenceInline: boolean) => ({
      hlsMasterKey: 'reels/user-1/attempt-1/master.m3u8',
      thumbnailKey: 'reels/user-1/attempt-1/thumbnail.jpg',
      sourceHasAudio: true,
      sourceLengthClass: 'SHORT' as const,
      variants: [],
      hlsObjectCount: 4,
      hlsTotalBytes: 100,
      evidenceInline,
      checksums: {
        sourceSha256: 'source',
        hlsMasterSha256: 'hls',
        thumbnailSha256: 'thumb',
      },
    });

    for (const inline of [true, false]) {
      outboxCreate.mockClear();
      await ContentRepository.prototype.completeMediaProcessing.call(
        repository,
        {
          reelId: 'reel-1',
          mediaAttemptId: 'media-attempt-1',
          mediaMetadata: { sourceDurationMs: 90_000 },
          mediaOutput: output(inline),
        },
      );
      const event = (
        outboxCreate.mock.calls[0] as [
          { data: { nextAttemptAt: Date; createdAt: Date } },
        ]
      )[0].data;
      expect(event.nextAttemptAt.getTime() - event.createdAt.getTime()).toBe(
        inline ? 600_000 : 0,
      );
    }
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
  it('lets the evidence job claim a completed reel whose stage a late media progress update overwrote', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const repository = { reel: { updateMany } } as unknown as ContentRepository;
    await ContentRepository.prototype.claimProcessingAttempt.call(repository, {
      reelId: 'reel-1',
      processingAttemptId: 'attempt-1',
      evidenceOnly: true,
    });
    const where = updateMany.mock.calls[0][0].where;
    expect(where.mediaStatus).toBe('COMPLETED');
    expect(where.processingStage.in).toEqual(
      expect.arrayContaining(['MEDIA_READY', 'VALIDATING_STREAM']),
    );
    expect(where.processingStage.in).not.toContain('EVIDENCE_PROCESSING');
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

describe('ContentRepository upload transaction queueing', () => {
  // The content database runs with connection_limit=1, so concurrent publishes
  // queue for the connection; Prisma's default 2 s maxWait made bursts fail.
  const maxWaitOf = (transaction: jest.Mock): number => {
    const options = transaction.mock.calls[0]?.[1] as
      | { maxWait?: number }
      | undefined;
    return options?.maxWait ?? 0;
  };

  it('lets a Reel upload lease reservation wait for the pooled connection', async () => {
    const $transaction = jest.fn().mockResolvedValue(undefined);
    await ContentRepository.prototype.reserveReelUploadLease.call(
      { $transaction },
      {
        userId: 'user-1',
        publishIntentId: 'intent-1',
        mediaKey: 'reels/user-1/source.mp4',
        fileType: 'video/mp4',
        expiresAt: new Date(0),
      },
    );
    expect(maxWaitOf($transaction)).toBeGreaterThanOrEqual(10_000);
  });

  it('lets Reel creation wait for the pooled connection', async () => {
    const $transaction = jest.fn().mockRejectedValue(new Error('stop'));
    await expect(
      ContentRepository.prototype.createReelWithMediaJob.call(
        { $transaction },
        { id: 'reel-1' },
        {},
      ),
    ).rejects.toThrow('stop');
    expect(maxWaitOf($transaction)).toBeGreaterThanOrEqual(10_000);
  });
});

describe('ContentRepository failIndexing', () => {
  const build = (counts: number[]) => {
    const updateMany = jest.fn();
    for (const count of counts) updateMany.mockResolvedValueOnce({ count });
    const repository = {
      reel: {
        updateMany,
        findUnique: jest.fn().mockResolvedValue({ mediaAttemptId: 'media-1' }),
      },
      reelMediaAttemptLease: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      recommendationFeedCacheRepository: {
        invalidateReels: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as ContentRepository;
    return { repository, updateMany };
  };
  const input = {
    reelId: 'reel-1',
    indexAttemptId: 'index-1',
    errorDetail: 'Visual provider rate limit or quota exhausted',
  };
  type UpdateCall = [
    {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    },
  ];

  it('keeps a reel that was indexed before searchable when a re-index fails', async () => {
    const { repository, updateMany } = build([1]);

    await expect(
      ContentRepository.prototype.failIndexing.call(repository, input),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = updateMany.mock.calls[0] as UpdateCall;
    expect(where).toMatchObject({
      indexCompletedAt: { not: null },
      indexChunkCount: { gt: 0 },
    });
    expect(data).toMatchObject({
      indexStatus: 'COMPLETED',
      processingErrorCode: 'REINDEX_FAILED',
      processingErrorDetail: expect.stringContaining('quota exhausted'),
    });
  });

  it('marks a reel that never had an index as failed', async () => {
    const { repository, updateMany } = build([0, 1]);

    await expect(
      ContentRepository.prototype.failIndexing.call(repository, input),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledTimes(2);
    const [{ where, data }] = updateMany.mock.calls[1] as UpdateCall;
    expect(where).not.toHaveProperty('indexCompletedAt');
    expect(data).toMatchObject({
      indexStatus: 'FAILED',
      processingErrorCode: 'INDEXING_FAILED',
    });
  });

  it('does nothing for a stale attempt', async () => {
    const { repository } = build([0, 0]);

    await expect(
      ContentRepository.prototype.failIndexing.call(repository, input),
    ).resolves.toBe(false);
  });
});

describe('ContentRepository markIndexSkipped', () => {
  const build = (counts: number[]) => {
    const updateMany = jest.fn();
    for (const count of counts) updateMany.mockResolvedValueOnce({ count });
    const leaseUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const invalidateReels = jest.fn().mockResolvedValue(undefined);
    const repository = {
      reel: {
        updateMany,
        findUnique: jest.fn().mockResolvedValue({ mediaAttemptId: 'media-1' }),
      },
      reelMediaAttemptLease: { updateMany: leaseUpdateMany },
      recommendationFeedCacheRepository: { invalidateReels },
    } as unknown as ContentRepository;
    return { repository, updateMany, leaseUpdateMany, invalidateReels };
  };
  const input = { reelId: 'reel-1', indexAttemptId: 'index-1' };
  type UpdateCall = [
    { where: Record<string, unknown>; data: Record<string, unknown> },
  ];

  it('finishes a never-indexed reel as READY without an index', async () => {
    const { repository, updateMany, leaseUpdateMany, invalidateReels } = build([
      0, 1,
    ]);

    await expect(
      ContentRepository.prototype.markIndexSkipped.call(repository, input),
    ).resolves.toBe(true);

    const [{ where, data }] = updateMany.mock.calls[1] as UpdateCall;
    expect(where).toMatchObject({
      id: 'reel-1',
      indexAttemptId: 'index-1',
      indexStatus: 'PENDING',
    });
    expect(data).toMatchObject({
      indexStatus: 'NOT_REQUESTED',
      processingStage: 'READY',
      processingProgress: 100,
    });
    expect(leaseUpdateMany).toHaveBeenCalledTimes(1);
    expect(invalidateReels).toHaveBeenCalledWith(['reel-1']);
  });

  it('keeps the index of a reel that was indexed before', async () => {
    const { repository, updateMany } = build([1]);

    await expect(
      ContentRepository.prototype.markIndexSkipped.call(repository, input),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = updateMany.mock.calls[0] as UpdateCall;
    expect(where).toMatchObject({ indexCompletedAt: { not: null } });
    expect(data).toMatchObject({ indexStatus: 'COMPLETED' });
  });

  it('does nothing for a stale attempt', async () => {
    const { repository, leaseUpdateMany, invalidateReels } = build([0, 0]);

    await expect(
      ContentRepository.prototype.markIndexSkipped.call(repository, input),
    ).resolves.toBe(false);
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(invalidateReels).not.toHaveBeenCalled();
  });
});

describe('ContentRepository shared reel access', () => {
  it('keeps a shared reel available while a re-index is in flight', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ reelId: 'reel-1' }, { reelId: 'reel-2' }]);
    const repository = {
      reelShare: { findMany },
    } as unknown as ContentRepository;

    await expect(
      ContentRepository.prototype.findAccessibleSharedReelIds.call(repository, {
        userId: 'user-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toEqual(['reel-1', 'reel-2']);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId: 'conversation-1',
          reel: {
            mediaStatus: 'COMPLETED',
            indexStatus: { in: ['COMPLETED', 'PROCESSING'] },
          },
        },
      }),
    );
  });
});
