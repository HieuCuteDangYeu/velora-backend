import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { UserServiceAdapter } from './user-service.adapter';

const KEY = (id: string) => `conversation:user-profile:${id}`;
const user = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.test`,
  fullName: `Name ${id}`,
  username: `user_${id}`,
  picture: null,
  ...extra,
});

type SetCall = { key: string; value: string; mode: string; ttl: number };
type FakePipeline = {
  set: (key: string, value: string, mode: string, ttl: number) => FakePipeline;
  exec: () => Promise<unknown[]>;
};

function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const sets: SetCall[] = [];
  const redis = {
    mget: jest.fn(
      (keys: string[]): Promise<(string | null)[]> =>
        Promise.resolve(keys.map((key) => store.get(key) ?? null)),
    ),
    pipeline: jest.fn((): FakePipeline => {
      const pending: SetCall[] = [];
      const pipeline: FakePipeline = {
        set: (key, value, mode, ttl) => {
          pending.push({ key, value, mode, ttl });
          return pipeline;
        },
        exec: () => {
          for (const entry of pending) {
            store.set(entry.key, entry.value);
            sets.push(entry);
          }
          return Promise.resolve([]);
        },
      };
      return pipeline;
    }),
  };
  return { redis, store, sets };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('User profile cache in the user-service adapter', () => {
  const originalTtl = process.env['USER_PROFILE_CACHE_TTL_SECONDS'];
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    if (originalTtl === undefined)
      delete process.env['USER_PROFILE_CACHE_TTL_SECONDS'];
    else process.env['USER_PROFILE_CACHE_TTL_SECONDS'] = originalTtl;
    jest.restoreAllMocks();
  });

  it('serves a lookup entirely from Redis when every profile is cached, with no RPC', async () => {
    const { redis } = fakeRedis({
      [KEY('a')]: JSON.stringify(user('a')),
      [KEY('b')]: JSON.stringify(user('b')),
    });
    const send = jest.fn();
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    const result = await adapter.findUsersByIds(['b', 'a']);

    expect(send).not.toHaveBeenCalled();
    expect(redis.mget).toHaveBeenCalledWith([KEY('a'), KEY('b')]);
    expect(result).toEqual(expect.arrayContaining([user('a'), user('b')]));
    expect(result).toHaveLength(2);
  });

  it('asks the user service only for the missing profiles and merges them', async () => {
    const { redis } = fakeRedis({ [KEY('a')]: JSON.stringify(user('a')) });
    const send = jest.fn().mockReturnValue(of([user('b')]));
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    const result = (await adapter.findUsersByIds(['a', 'b'])) as unknown as {
      id: string;
    }[];

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('user.find_by_ids', ['b']);
    expect(result.map((u) => u.id).sort()).toEqual(['a', 'b']);
  });

  it('caches fetched profiles for 60 seconds by default and stores display fields only', async () => {
    const { redis, sets, store } = fakeRedis();
    const send = jest.fn().mockReturnValue(
      of([
        user('a', {
          password: 'hash',
          provider: 'google',
          providerId: 'x',
          isVerified: true,
        }),
      ]),
    );
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    await adapter.findUsersByIds(['a']);
    await flush();

    expect(sets).toEqual([
      { key: KEY('a'), value: expect.any(String), mode: 'EX', ttl: 60 },
    ]);
    const stored = JSON.parse(store.get(KEY('a'))!) as Record<string, unknown>;
    expect(stored).toEqual({
      id: 'a',
      email: 'a@example.test',
      fullName: 'Name a',
      username: 'user_a',
      picture: null,
    });
    expect(stored).not.toHaveProperty('password');
    expect(stored).not.toHaveProperty('provider');
  });

  it('a second lookup after the first completes does not call the user service again', async () => {
    const { redis } = fakeRedis();
    const send = jest.fn().mockReturnValue(of([user('a'), user('b')]));
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    await adapter.findUsersByIds(['a', 'b']);
    await flush();
    await adapter.findUsersByIds(['a', 'b']);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns the raw response unchanged when nothing was cached', async () => {
    const { redis } = fakeRedis();
    const users = [user('a')];
    const send = jest.fn().mockReturnValue(of(users));
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    expect(await adapter.findUsersByIds(['a'])).toBe(users);
  });

  it('serves cached profiles when the lookup for the rest fails, and null when nothing is cached', async () => {
    const { redis } = fakeRedis({ [KEY('a')]: JSON.stringify(user('a')) });
    const send = jest.fn().mockReturnValue(throwError(() => new Error('down')));
    jest.spyOn(console, 'warn').mockImplementation();
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    expect(await adapter.findUsersByIds(['a', 'b'])).toEqual([user('a')]);
    expect(await adapter.findUsersByIds(['c'])).toBeNull();
  });

  it('treats a corrupt or mismatched cache entry as a miss', async () => {
    const { redis } = fakeRedis({
      [KEY('a')]: '{not json',
      [KEY('b')]: JSON.stringify(user('someone-else')),
    });
    const send = jest.fn().mockReturnValue(of([user('a'), user('b')]));
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    await adapter.findUsersByIds(['a', 'b']);

    expect(send).toHaveBeenCalledWith('user.find_by_ids', ['a', 'b']);
  });

  it('falls back to the user service when Redis reads or writes fail', async () => {
    const { redis } = fakeRedis();
    redis.mget.mockRejectedValue(new Error('redis down'));
    redis.pipeline.mockImplementation(() => {
      throw new Error('redis down');
    });
    const users = [user('a')];
    const send = jest.fn().mockReturnValue(of(users));
    const adapter = new UserServiceAdapter(
      { send } as never,
      undefined,
      redis as never,
    );

    expect(await adapter.findUsersByIds(['a'])).toBe(users);
    expect(send).toHaveBeenCalledWith('user.find_by_ids', ['a']);
  });

  it.each(['0', '-5', 'abc'])(
    'the cache is off when USER_PROFILE_CACHE_TTL_SECONDS is %p',
    async (value) => {
      process.env['USER_PROFILE_CACHE_TTL_SECONDS'] = value;
      const { redis } = fakeRedis({ [KEY('a')]: JSON.stringify(user('a')) });
      const send = jest.fn().mockReturnValue(of([user('a')]));
      const adapter = new UserServiceAdapter(
        { send } as never,
        undefined,
        redis as never,
      );

      await adapter.findUsersByIds(['a']);

      expect(redis.mget).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('user.find_by_ids', ['a']);
    },
  );

  it('honours a custom TTL and caps it at ten minutes', async () => {
    for (const [raw, expected] of [
      ['30', 30],
      ['99999', 600],
    ] as const) {
      process.env['USER_PROFILE_CACHE_TTL_SECONDS'] = raw;
      const { redis, sets } = fakeRedis();
      const send = jest.fn().mockReturnValue(of([user('a')]));
      const adapter = new UserServiceAdapter(
        { send } as never,
        undefined,
        redis as never,
      );
      await adapter.findUsersByIds(['a']);
      await flush();
      expect(sets[0].ttl).toBe(expected);
    }
  });
});
