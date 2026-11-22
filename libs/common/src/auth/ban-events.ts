import type Redis from 'ioredis';

/** Auth-service publishes a banned user id here; every socket gateway replica drops that user. */
export const USER_BANNED_CHANNEL = 'auth:user-banned';

/** Returns a function that stops listening. ioredis re-subscribes by itself after a reconnect. */
export async function subscribeToUserBans(
  redis: Redis,
  onBan: (userId: string) => void,
): Promise<() => Promise<void>> {
  const subscriber = redis.duplicate();
  subscriber.on('error', () => undefined);
  subscriber.on('message', (_channel: string, userId: string) => {
    try {
      onBan(userId);
    } catch {
      // A failed disconnect must not stop later bans from being handled.
    }
  });
  await subscriber.subscribe(USER_BANNED_CHANNEL);
  return async () => {
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  };
}
