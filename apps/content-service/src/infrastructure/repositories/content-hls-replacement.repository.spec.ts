import { createHash } from 'node:crypto';
import { ContentRepository } from './content.repository';
import {
  reelHlsPlanSha256,
  type ReelHlsReplacementPlan,
} from '@common/content/reel-hls-replacement';
import { Prisma } from '@prisma/content-client';

function fixture() {
  const plan: ReelHlsReplacementPlan = {
    schemaVersion: 1,
    reelId: '12345678-1234-1234-1234-123456789abc',
    userId: 'owner',
    attemptId: '87654321-1234-1234-1234-123456789abc',
    expectedUpdatedAt: '2026-10-20T00:00:00.000Z',
    previousHlsMasterKey:
      'reels/12345678-1234-1234-1234-123456789abc/master.m3u8',
    mediaKeySha256: createHash('sha256')
      .update('https://source.example/video.mp4')
      .digest('hex'),
    mediaAttemptId: 'old-media',
    indexAttemptId: 'old-index',
    sourceSha256: 'a'.repeat(64),
    sourceMode: 'PUBLISHED_HLS',
    outputDurationMs: 4000,
    segmentSeconds: 2,
    outputFps: 25,
    variants: [{ name: '360p', width: 360, height: 640 }],
    files: [{ path: 'master.m3u8', bytes: 100, sha256: 'b'.repeat(64) }],
  };
  const row = {
    id: plan.reelId,
    userId: plan.userId,
    mediaKey: 'https://source.example/video.mp4',
    hlsMasterKey: plan.previousHlsMasterKey,
    updatedAt: new Date(plan.expectedUpdatedAt),
    mediaAttemptId: 'old-media',
    indexAttemptId: 'old-index',
    mediaStatus: 'COMPLETED',
    indexStatus: 'COMPLETED',
    visibility: 'private',
    seriesId: 'series',
    episodeNumber: 3,
    transcriptionAudioManifestKey: 'audio-original',
    visualFrameManifestKey: 'visual-original',
    sourceDurationMs: 60000,
    encodedVariantCount: 1,
    encodedMaxHeight: 1920,
    encodedFps: 25,
    mediaOutput: {
      hlsMasterKey: plan.previousHlsMasterKey,
      thumbnailKey: 'old-thumbnail',
      checksums: { sourceSha256: 'c'.repeat(64) },
    } as Prisma.JsonObject,
  };
  type Event = {
    id: string;
    eventType: string;
    aggregateId: string;
    payload: Prisma.JsonValue;
  };
  type Lease = { reelId: string; expiresAt: Date; completedAt?: Date | null };
  const events = new Map<string, Event>();
  const leases = new Map<string, Lease>();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    reel: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...row })),
      updateMany: jest.fn(({ data }: { data: Partial<typeof row> }) => {
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      }),
    },
    reelMediaAttemptLease: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(({ where }: { where: { attemptId: string } }) =>
        Promise.resolve(leases.get(where.attemptId) ?? null),
      ),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { attemptId: string };
          create: Lease;
          update: Partial<Lease>;
        }) => {
          leases.set(
            where.attemptId,
            leases.has(where.attemptId)
              ? { ...leases.get(where.attemptId)!, ...update }
              : create,
          );
          return Promise.resolve();
        },
      ),
    },
    outboxEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(events.get(where.id) ?? null),
      ),
      create: jest.fn(({ data }: { data: Event }) => {
        events.set(data.id, data);
        return Promise.resolve(data);
      }),
    },
  };
  const cache = { invalidateReels: jest.fn().mockResolvedValue(undefined) };
  const repository = Object.create(
    ContentRepository.prototype,
  ) as ContentRepository;
  Object.assign(repository, {
    $transaction: (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    recommendationFeedCacheRepository: cache,
  });
  return {
    plan,
    row,
    tx,
    cache,
    events,
    leases,
    repository,
    command: {
      action: 'APPLY' as const,
      plan,
      reviewedSha256: reelHlsPlanSha256(plan),
    },
  };
}

describe('Content HLS replacement CAS and rollback', () => {
  it('reserves a lease without changing the playable row and preserves all identity, access and index/evidence fields across apply and rollback', async () => {
    const f = fixture();
    const original = structuredClone(f.row);
    await f.repository.reserveReelHlsReplacement(f.plan);
    expect(f.row).toEqual(original);
    const applied = await f.repository.completeReelHlsReplacement(f.command);
    expect(applied.hlsMasterKey).toContain(`/${f.plan.attemptId}/master.m3u8`);
    for (const key of [
      'userId',
      'mediaKey',
      'mediaAttemptId',
      'indexAttemptId',
      'indexStatus',
      'visibility',
      'seriesId',
      'episodeNumber',
      'transcriptionAudioManifestKey',
      'visualFrameManifestKey',
      'sourceDurationMs',
    ])
      expect(f.row[key]).toEqual(original[key]);
    expect(f.row.mediaOutput.checksums).toMatchObject({
      sourceSha256: 'c'.repeat(64),
      hlsMasterSha256: 'b'.repeat(64),
    });
    expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    const replay = await f.repository.completeReelHlsReplacement(f.command);
    expect(replay).toEqual(applied);
    expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    const rollback = await f.repository.completeReelHlsReplacement({
      ...f.command,
      action: 'ROLLBACK',
    });
    expect(rollback.hlsMasterKey).toBe(original.hlsMasterKey);
    expect(f.row.mediaOutput).toEqual(original.mediaOutput);
    expect(f.row.encodedMaxHeight).toBe(original.encodedMaxHeight);
    expect(f.cache.invalidateReels).toHaveBeenCalledWith([f.plan.reelId]);
    expect(f.tx.outboxEvent.create).toHaveBeenCalledTimes(2);
    expect(
      await f.repository.completeReelHlsReplacement({
        ...f.command,
        action: 'ROLLBACK',
      }),
    ).toEqual(rollback);
  });

  it.each(['state', 'active', 'pending', 'lease'])(
    'blocks replacement reservation on a conflicting %s',
    async (conflict) => {
      const f = fixture();
      if (conflict === 'state') f.row.updatedAt = new Date();
      if (conflict === 'active') f.row.indexStatus = 'PROCESSING';
      if (conflict === 'pending')
        f.tx.outboxEvent.findFirst.mockResolvedValue({
          id: 'pending',
        });
      if (conflict === 'lease')
        f.tx.reelMediaAttemptLease.findFirst.mockResolvedValue({
          attemptId: 'other',
        });
      await expect(
        f.repository.reserveReelHlsReplacement(f.plan),
      ).rejects.toThrow();
      expect(f.tx.reel.updateMany).not.toHaveBeenCalled();
      expect(f.tx.reelMediaAttemptLease.upsert).not.toHaveBeenCalled();
    },
  );

  it('rejects expired leases, a lost CAS and rollback after another row update', async () => {
    const f = fixture();
    await f.repository.reserveReelHlsReplacement(f.plan);
    f.leases.get(f.plan.attemptId)!.expiresAt = new Date(0);
    await expect(
      f.repository.completeReelHlsReplacement(f.command),
    ).rejects.toThrow('expired');
    f.leases.get(f.plan.attemptId)!.expiresAt = new Date(Date.now() + 60000);
    f.tx.reel.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      f.repository.completeReelHlsReplacement(f.command),
    ).rejects.toThrow('compare-and-swap');
    expect(f.events.size).toBe(0);
    await f.repository.completeReelHlsReplacement(f.command);
    f.row.updatedAt = new Date(f.row.updatedAt.getTime() + 1);
    await expect(
      f.repository.completeReelHlsReplacement({
        ...f.command,
        action: 'ROLLBACK',
      }),
    ).rejects.toThrow('lost the applied version');
  });

  it('keeps a durable invalidation event and supports retry when cache invalidation fails after commit', async () => {
    const f = fixture();
    await f.repository.reserveReelHlsReplacement(f.plan);
    f.cache.invalidateReels.mockRejectedValueOnce(
      new Error('cache unavailable'),
    );
    await expect(
      f.repository.completeReelHlsReplacement(f.command),
    ).rejects.toThrow('cache unavailable');
    expect(f.events.size).toBe(1);
    await expect(
      f.repository.completeReelHlsReplacement(f.command),
    ).resolves.toHaveProperty('hlsMasterKey');
    expect(f.tx.reel.updateMany).toHaveBeenCalledTimes(1);
  });
});
