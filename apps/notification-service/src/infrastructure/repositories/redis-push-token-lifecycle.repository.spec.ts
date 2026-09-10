import { createHash } from 'node:crypto';

import { RedisPushTokenLifecycleRepository } from './redis-push-token-lifecycle.repository';

describe('RedisPushTokenLifecycleRepository', () => {
  it('atomically records lifecycle ordering under a hashed installation key', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue(1),
    };
    const repository = new RedisPushTokenLifecycleRepository(redis as never);
    const input = {
      provider: 'fcm' as const,
      deviceId: 'installation-1',
      lifecycleVersion: 2,
    };

    await expect(repository.advance(input, 'register')).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('candidateVersion'),
      1,
      `notification:push-token-lifecycle:${createHash('sha256')
        .update('fcm:installation-1')
        .digest('hex')}`,
      '2',
      'register',
      '900',
    );
  });
});
