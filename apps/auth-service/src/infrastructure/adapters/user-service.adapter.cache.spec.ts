import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { UserServiceAdapter } from './user-service.adapter';

const KEY = (id: string) => `auth:verify-user:${id}`;
const fullUser = {
  id: 'u1',
  email: 'u1@example.test',
  fullName: 'User One',
  username: 'user_one',
  picture: null,
  isVerified: true,
  password: 'hashed-secret',
  providerId: 'google-1',
};

function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
  };
}

describe('Verified-user cache in the auth user-service adapter', () => {
  const originalTtl = process.env['AUTH_USER_CACHE_TTL_SECONDS'];
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    if (originalTtl === undefined)
      delete process.env['AUTH_USER_CACHE_TTL_SECONDS'];
    else process.env['AUTH_USER_CACHE_TTL_SECONDS'] = originalTtl;
    jest.restoreAllMocks();
  });

  it('fetches over RPC once, stores identity fields only for 30 s, then serves from Redis', async () => {
    const redis = fakeRedis();
    const send = jest.fn(() => of(fullUser));
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    const first = await adapter.findByIdForAuth('u1');
    const second = await adapter.findByIdForAuth('u1');

    expect(first).toEqual(fullUser);
    expect(send).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      KEY('u1'),
      expect.any(String),
      'EX',
      30,
    );
    const stored = JSON.parse(redis.store.get(KEY('u1'))!) as Record<
      string,
      unknown
    >;
    expect(stored).not.toHaveProperty('password');
    expect(stored).not.toHaveProperty('providerId');
    expect(second).toMatchObject({
      id: 'u1',
      email: 'u1@example.test',
      isVerified: true,
    });
  });

  it('honours AUTH_USER_CACHE_TTL_SECONDS and disables caching at 0', async () => {
    process.env['AUTH_USER_CACHE_TTL_SECONDS'] = '10';
    const redis = fakeRedis();
    const send = jest.fn(() => of(fullUser));
    await new UserServiceAdapter(
      { send } as never,
      redis as never,
    ).findByIdForAuth('u1');
    expect(redis.set).toHaveBeenCalledWith(
      KEY('u1'),
      expect.any(String),
      'EX',
      10,
    );

    process.env['AUTH_USER_CACHE_TTL_SECONDS'] = '0';
    const off = fakeRedis();
    const disabled = new UserServiceAdapter({ send } as never, off as never);
    await disabled.findByIdForAuth('u1');
    expect(off.get).not.toHaveBeenCalled();
    expect(off.set).not.toHaveBeenCalled();
  });

  it('never caches a missing user', async () => {
    const redis = fakeRedis();
    const send = jest.fn(() => of(null));
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    await expect(adapter.findByIdForAuth('u1')).resolves.toBeNull();
    await expect(adapter.findByIdForAuth('u1')).resolves.toBeNull();

    expect(redis.set).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    const redis = fakeRedis();
    const send = jest.fn(() => {
      throw new Error('rmq down');
    });
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    await expect(adapter.findByIdForAuth('u1')).rejects.toThrow('rmq down');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('falls back to the RPC when Redis reads and writes fail', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.set.mockRejectedValue(new Error('redis down'));
    const send = jest.fn(() => of(fullUser));
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    await expect(adapter.findByIdForAuth('u1')).resolves.toEqual(fullUser);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt or mismatched entry as a miss', async () => {
    const redis = fakeRedis({
      [KEY('u1')]: '{not json',
      [KEY('u2')]: JSON.stringify({ id: 'someone-else' }),
    });
    const send = jest.fn((_pattern: string, id: string) =>
      of({ ...fullUser, id }),
    );
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    await expect(adapter.findByIdForAuth('u1')).resolves.toMatchObject({
      id: 'u1',
    });
    await expect(adapter.findByIdForAuth('u2')).resolves.toMatchObject({
      id: 'u2',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('works without Redis', async () => {
    const send = jest.fn(() => of(fullUser));
    const adapter = new UserServiceAdapter({ send } as never);
    await expect(adapter.findByIdForAuth('u1')).resolves.toEqual(fullUser);
    await expect(adapter.invalidateCachedUser('u1')).resolves.toBeUndefined();
  });

  it('keeps plain findById uncached for refresh flows', async () => {
    const redis = fakeRedis({ [KEY('u1')]: JSON.stringify(fullUser) });
    const send = jest.fn(() => of({ ...fullUser, isVerified: false }));
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    await expect(adapter.findById('u1')).resolves.toMatchObject({
      isVerified: false,
    });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('evicts the entry on invalidation, verification and update', async () => {
    const redis = fakeRedis({ [KEY('u1')]: JSON.stringify(fullUser) });
    const send = jest.fn(() => of(undefined));
    const adapter = new UserServiceAdapter({ send } as never, redis as never);

    await adapter.invalidateCachedUser('u1');
    expect(redis.store.has(KEY('u1'))).toBe(false);

    redis.store.set(KEY('u1'), '{}');
    await adapter.verifyUser('u1');
    expect(redis.store.has(KEY('u1'))).toBe(false);

    redis.store.set(KEY('u1'), '{}');
    await adapter.updateUser({ id: 'u1', data: {} });
    expect(redis.store.has(KEY('u1'))).toBe(false);
  });

  it('survives an eviction failure', async () => {
    const redis = fakeRedis();
    redis.del.mockRejectedValue(new Error('redis down'));
    const adapter = new UserServiceAdapter(
      { send: jest.fn() } as never,
      redis as never,
    );
    await expect(adapter.invalidateCachedUser('u1')).resolves.toBeUndefined();
  });
});
