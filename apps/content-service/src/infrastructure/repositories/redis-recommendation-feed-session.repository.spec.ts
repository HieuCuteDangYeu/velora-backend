import type Redis from 'ioredis';
import { RedisRecommendationFeedSessionRepository } from './redis-recommendation-feed-session.repository';

describe('RedisRecommendationFeedSessionRepository', () => {
  const session = {
    feedSessionId: '2f628c36-e32d-4b0c-8df5-c1f91087a003',
    viewerId: 'viewer-1',
    algorithmVersion: 'personalized-ranker-v2',
    generatedAt: '2026-09-11T10:00:00.000Z',
    excludedUserIds: [],
    items: [
      {
        reelId: 'reel-1',
        primarySource: 'RECENT_QUALITY' as const,
        sources: ['RECENT_QUALITY' as const],
      },
    ],
  };

  it('stores a session with an expiry', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const repository = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockResolvedValue(null),
      set,
    } as unknown as Redis);

    await repository.save(session, 900);

    expect(set).toHaveBeenCalledWith(
      `recommendation:reel-feed:v2:${session.feedSessionId}`,
      JSON.stringify(session),
      'EX',
      900,
    );
  });

  it('loads a valid session', async () => {
    const repository = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockResolvedValue(JSON.stringify(session)),
    } as unknown as Redis);

    await expect(repository.get(session.feedSessionId)).resolves.toEqual(
      session,
    );
  });

  it('refuses to overwrite a feed session owned by another viewer', async () => {
    const set = jest.fn();
    const repository = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          ...session,
          viewerId: 'viewer-2',
        }),
      ),
      set,
    } as unknown as Redis);

    await repository.save(session, 900);

    expect(set).not.toHaveBeenCalled();
  });

  it('fails open on malformed or unavailable cache data', async () => {
    const malformed = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockResolvedValue('{"invalid":true}'),
    } as unknown as Redis);
    const unavailable = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as Redis);

    await expect(malformed.get(session.feedSessionId)).resolves.toBeNull();
    await expect(unavailable.get(session.feedSessionId)).resolves.toBeNull();
  });

  it('does not let a stale refill lock owner delete a replacement lock', async () => {
    let lockValue: string | null = null;
    const set = jest.fn().mockImplementation((_key: string, value: string) => {
      if (lockValue !== null) return null;
      lockValue = value;
      return 'OK';
    });
    const evalCommand = jest.fn().mockImplementation((...args: unknown[]) => {
      const lockToken = args[3] as string;
      if (lockValue !== lockToken) return 0;
      lockValue = null;
      return 1;
    });
    const repository = new RedisRecommendationFeedSessionRepository({
      set,
      eval: evalCommand,
    } as unknown as Redis);

    const firstToken = await repository.tryAcquireRefillLock(
      session.feedSessionId,
      60,
    );
    expect(firstToken).toEqual(expect.any(String));

    lockValue = null;
    const replacementToken = await repository.tryAcquireRefillLock(
      session.feedSessionId,
      60,
    );
    expect(replacementToken).toEqual(expect.any(String));
    expect(replacementToken).not.toBe(firstToken);

    await repository.releaseRefillLock(session.feedSessionId, firstToken!);
    expect(lockValue).toBe(replacementToken);

    await repository.releaseRefillLock(
      session.feedSessionId,
      replacementToken!,
    );
    expect(lockValue).toBeNull();
    expect(evalCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      `recommendation:reel-feed:v2:${session.feedSessionId}:refill-lock`,
      firstToken,
    );
  });
});
