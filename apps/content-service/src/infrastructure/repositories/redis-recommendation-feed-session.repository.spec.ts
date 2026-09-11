import { RedisRecommendationFeedSessionRepository } from './redis-recommendation-feed-session.repository';

describe('RedisRecommendationFeedSessionRepository', () => {
  const session = {
    feedSessionId: '2f628c36-e32d-4b0c-8df5-c1f91087a003',
    viewerId: 'viewer-1',
    algorithmVersion: 'personalized-ranker-v2',
    generatedAt: '2026-09-11T10:00:00.000Z',
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
      set,
    } as any);

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
    } as any);

    await expect(repository.get(session.feedSessionId)).resolves.toEqual(session);
  });

  it('fails open on malformed or unavailable cache data', async () => {
    const malformed = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockResolvedValue('{"invalid":true}'),
    } as any);
    const unavailable = new RedisRecommendationFeedSessionRepository({
      get: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    } as any);

    await expect(malformed.get(session.feedSessionId)).resolves.toBeNull();
    await expect(unavailable.get(session.feedSessionId)).resolves.toBeNull();
  });
});
