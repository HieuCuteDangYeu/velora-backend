import { subscribeToUserBans, USER_BANNED_CHANNEL } from './ban-events';

describe('subscribeToUserBans', () => {
  const fakeRedis = () => {
    let listener: (channel: string, message: string) => void = () => undefined;
    const subscriber = {
      on: jest.fn((event: string, cb: never) => {
        if (event === 'message') listener = cb;
      }),
      subscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
    };
    return {
      subscriber,
      emit: (id: string) => listener(USER_BANNED_CHANNEL, id),
      redis: { duplicate: () => subscriber } as never,
    };
  };

  it('hands every banned user id to the handler', async () => {
    const f = fakeRedis();
    const onBan = jest.fn();
    await subscribeToUserBans(f.redis, onBan);
    expect(f.subscriber.subscribe).toHaveBeenCalledWith(USER_BANNED_CHANNEL);
    f.emit('user-1');
    expect(onBan).toHaveBeenCalledWith('user-1');
  });

  it('keeps listening after a handler throws', async () => {
    const f = fakeRedis();
    const onBan = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockImplementationOnce(() => undefined);
    await subscribeToUserBans(f.redis, onBan);
    f.emit('a');
    f.emit('b');
    expect(onBan).toHaveBeenCalledTimes(2);
  });

  it('stops by quitting the subscriber connection', async () => {
    const f = fakeRedis();
    const stop = await subscribeToUserBans(f.redis, jest.fn());
    await stop();
    expect(f.subscriber.quit).toHaveBeenCalled();
  });
});
