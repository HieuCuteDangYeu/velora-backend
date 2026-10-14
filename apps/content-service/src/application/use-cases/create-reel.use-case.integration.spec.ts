import { CreateReelUseCase } from './create-reel.use-case';
import { BuildReelMediaJobUseCase } from './build-reel-media-job.use-case';
import { ClassifyReelJobLengthUseCase } from './classify-reel-job-length.use-case';
import { ContentRepository } from '@content/infrastructure/repositories/content.repository';

const runIfDatabase =
  process.env.RUN_REEL_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runIfDatabase('CreateReelUseCase PostgreSQL idempotency', () => {
  let repository: ContentRepository;
  let useCase: CreateReelUseCase;
  let storage: { checkFileExists: jest.Mock; deleteObjects: jest.Mock };
  const userId = `integration-${Date.now()}`;
  const publishIntentId = '22222222-2222-4222-8222-222222222222';
  const payload = {
    publishIntentId,
    mediaKey: `reels/${userId}/source.mp4`,
    title: 'Original title',
    description: 'Original description',
    tags: ['#Tag'],
    visibility: 'private' as const,
    clientObservedDurationMs: 12_345.678,
  };

  beforeAll(() => {
    storage = {
      checkFileExists: jest.fn().mockResolvedValue(true),
      deleteObjects: jest.fn().mockResolvedValue(undefined),
    };
    repository = new ContentRepository(
      { get: jest.fn(() => 'reel-index-v2') } as never,
      {} as never,
      {} as never,
      { invalidateReels: jest.fn().mockResolvedValue(undefined) } as never,
      storage as never,
    );
    useCase = new CreateReelUseCase(
      repository,
      storage,
      { trigger: jest.fn() },
      new BuildReelMediaJobUseCase(
        new ClassifyReelJobLengthUseCase({
          get: jest.fn(() => undefined),
        } as never),
      ),
    );
  });

  afterAll(async () => {
    const reel = await repository.reel.findFirst({ where: { userId } });
    if (reel) {
      await repository.outboxEvent.deleteMany({
        where: { aggregateId: reel.id },
      });
      await repository.reel.delete({ where: { id: reel.id } });
    }
    await repository.$disconnect();
  });

  it('allows the deployed legacy client to insert without the new intent column', async () => {
    const id = `legacy-client-${Date.now()}`;
    const rows = await repository.$queryRaw<Array<{ publishIntentId: string }>>`
      INSERT INTO "Reel" ("id", "userId", "mediaKey", "updatedAt")
      VALUES (${id}, ${userId}, ${payload.mediaKey}, NOW())
      RETURNING "publishIntentId"
    `;
    expect(rows[0].publishIntentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    await repository.reel.delete({ where: { id } });
  });

  it('returns one canonical Reel for concurrent callers and replays after content edits', async () => {
    await repository.reserveReelUploadLease({
      userId,
      publishIntentId,
      mediaKey: payload.mediaKey,
      fileType: 'video/mp4',
      expiresAt: new Date(Date.now() + 300_000),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => useCase.execute(userId, payload)),
    );
    const ids = new Set(results.map((reel) => reel.id));
    expect(ids.size).toBe(1);

    expect(
      await repository.reelUploadLease.findUnique({
        where: {
          userId_publishIntentId_fileType: {
            userId,
            publishIntentId,
            fileType: 'video/mp4',
          },
        },
      }),
    ).toEqual(expect.objectContaining({ adoptedAt: expect.any(Date) }));

    const reelId = results[0].id;
    expect(
      await repository.reel.count({
        where: { userId, publishIntentId },
      }),
    ).toBe(1);
    expect(
      await repository.outboxEvent.count({
        where: { aggregateId: reelId, eventType: 'reel.media.requested.v1' },
      }),
    ).toBe(1);

    await repository.updateReel(
      reelId,
      { title: 'Edited title', visibility: 'public' },
      userId,
    );
    const replay = await useCase.execute(userId, payload);
    expect(replay.id).toBe(reelId);
    expect(replay.title).toBe('Edited title');
    expect(replay.visibility).toBe('public');
    expect(
      await repository.outboxEvent.count({
        where: { aggregateId: reelId, eventType: 'reel.media.requested.v1' },
      }),
    ).toBe(1);
  });

  it('blocks adoption while an expired lease cleanup claim is in progress', async () => {
    const cleanupUser = `cleanup-${Date.now()}`;
    const cleanupIntent = '44444444-4444-4444-8444-444444444444';
    const cleanupKey = `reels/${cleanupUser}/cleanup.mp4`;
    await repository.reserveReelUploadLease({
      userId: cleanupUser,
      publishIntentId: cleanupIntent,
      mediaKey: cleanupKey,
      fileType: 'video/mp4',
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      repository.cleanupExpiredReelUploadLease(
        (
          await repository.reelUploadLease.findUniqueOrThrow({
            where: {
              userId_publishIntentId_fileType: {
                userId: cleanupUser,
                publishIntentId: cleanupIntent,
                fileType: 'video/mp4',
              },
            },
          })
        ).id,
        new Date(),
      ),
    ).resolves.toBe(true);

    await expect(
      repository.createReelWithMediaJob(
        {
          id: `cleanup-reel-${Date.now()}`,
          userId: cleanupUser,
          publishIntentId: cleanupIntent,
          publishRequestFingerprint: 'cleanup-fingerprint',
          mediaKey: cleanupKey,
          tags: [],
        },
        {
          id: `cleanup-outbox-${Date.now()}`,
          eventType: 'reel.media.requested.v1',
          payload: {
            jobId: 'cleanup-job',
            reelId: 'cleanup-reel',
            userId: cleanupUser,
            mediaKey: cleanupKey,
            mediaAttemptId: 'cleanup-attempt',
            expectedLengthClass: 'UNKNOWN',
            tags: [],
            createdAt: new Date().toISOString(),
            schemaVersion: 1,
          },
          createdAt: new Date(),
        },
      ),
    ).rejects.toThrow('upload lease is no longer active');

    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });

  it('rechecks a cleanup claim after waiting for the shared source lock', async () => {
    const owner = `renewal-${Date.now()}`;
    const intent = '55555555-5555-4555-8555-555555555555';
    const mediaKey = `reels/${owner}/source.mp4`;
    const input = {
      userId: owner,
      publishIntentId: intent,
      mediaKey,
      fileType: 'video/mp4',
      expiresAt: new Date(Date.now() - 1000),
    };
    await repository.reserveReelUploadLease(input);
    let unlock!: () => void;
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const claim = repository.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${mediaKey}))`;
      await transaction.reelUploadLease.updateMany({
        where: { mediaKey },
        data: { cancelledAt: new Date(), cleanupClaimedAt: new Date() },
      });
      ready();
      await release;
    });
    await locked;
    const renewal = repository.reserveReelUploadLease({
      ...input,
      expiresAt: new Date(Date.now() + 300000),
    });
    const creation = useCase.execute(owner, {
      ...payload,
      publishIntentId: intent,
      mediaKey,
    });
    const outcomes = Promise.allSettled([renewal, creation]);
    unlock();
    await claim;
    const results = await outcomes;
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    const lease = await repository.reelUploadLease.findFirstOrThrow({
      where: { mediaKey },
    });
    expect(lease.cleanupClaimedAt).not.toBeNull();
    expect(lease.cancelledAt).not.toBeNull();
    expect(await repository.reel.count({ where: { userId: owner } })).toBe(0);
  });

  it('serializes duplicate cleanup and permanently retires an expired upload key', async () => {
    const owner = `retired-${Date.now()}`;
    const input = {
      userId: owner,
      publishIntentId: '77777777-7777-4777-8777-777777777777',
      mediaKey: `reels/${owner}/source.mp4`,
      fileType: 'video/mp4',
      expiresAt: new Date(Date.now() - 1000),
    };
    await repository.reserveReelUploadLease(input);
    const lease = await repository.reelUploadLease.findFirstOrThrow({
      where: { mediaKey: input.mediaKey },
    });
    await repository.cleanupExpiredReelUploadLease(lease.id, new Date());
    storage.deleteObjects.mockClear();
    const results = await Promise.all([
      repository.completeReelUploadLeaseCleanup(lease.id, new Date()),
      repository.completeReelUploadLeaseCleanup(lease.id, new Date()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(storage.deleteObjects).toHaveBeenCalledTimes(1);
    await expect(
      repository.reserveReelUploadLease({
        ...input,
        expiresAt: new Date(Date.now() + 300000),
      }),
    ).rejects.toThrow('upload expired');
  });

  it('retains shared original media until the last Reel is deleted', async () => {
    const original = await repository.reel.findFirstOrThrow({
      where: { userId, publishIntentId },
    });
    const clone = await useCase.execute(userId, {
      ...payload,
      publishIntentId: '88888888-8888-4888-8888-888888888888',
    });
    await repository.deleteReel(original.id, userId);
    let lease = await repository.reelUploadLease.findFirstOrThrow({
      where: { mediaKey: payload.mediaKey },
    });
    expect(lease.cancelledAt).toBeNull();
    await repository.deleteReel(clone.id, userId);
    lease = await repository.reelUploadLease.findFirstOrThrow({
      where: { mediaKey: payload.mediaKey },
    });
    expect(lease.cancelledAt).not.toBeNull();
    expect(lease.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 23 * 60 * 60 * 1000,
    );
    await repository.outboxEvent.deleteMany({
      where: { aggregateId: { in: [original.id, clone.id] } },
    });
  });
});
