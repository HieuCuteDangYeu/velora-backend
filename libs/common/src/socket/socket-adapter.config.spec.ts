import { Logger } from '@nestjs/common';
import {
  configureSocketAdapter,
  isRedisAdapterEnabled,
  SOCKET_IO_REDIS_ADAPTER_ENV,
} from './socket-adapter.config';

const harness = (value?: string) => {
  const adapter = { connectToRedis: jest.fn().mockResolvedValue(undefined) };
  const app = { useWebSocketAdapter: jest.fn() };
  const config = {
    get: jest.fn((key: string) =>
      key === SOCKET_IO_REDIS_ADAPTER_ENV ? value : undefined,
    ),
  };
  const factory = jest.fn().mockReturnValue(adapter);
  return { adapter, app, config, factory };
};

describe('isRedisAdapterEnabled', () => {
  it.each([undefined, null, '', 'true', 'TRUE', '1', 'on', 'yes', 'maybe'])(
    'keeps the Redis adapter on for %p',
    (value) => {
      expect(isRedisAdapterEnabled(value)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', ' False ', '0', 'off', 'No', 'disabled'])(
    'turns it off only for the explicit value %p',
    (value) => {
      expect(isRedisAdapterEnabled(value)).toBe(false);
    },
  );
});

describe('configureSocketAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, 'true', 'unrecognised'])(
    'registers the Redis adapter by default (%p)',
    async (value) => {
      const { adapter, app, config, factory } = harness(value);

      await expect(
        configureSocketAdapter(app as never, config as never, factory),
      ).resolves.toBe(true);

      expect(factory).toHaveBeenCalledWith(app, config);
      expect(adapter.connectToRedis).toHaveBeenCalledTimes(1);
      expect(app.useWebSocketAdapter).toHaveBeenCalledWith(adapter);
    },
  );

  it('connects to Redis before registering the adapter', async () => {
    const { adapter, app, config, factory } = harness();
    const order: string[] = [];
    adapter.connectToRedis.mockImplementation(() => {
      order.push('connect');
      return Promise.resolve();
    });
    app.useWebSocketAdapter.mockImplementation(() => order.push('register'));

    await configureSocketAdapter(app as never, config as never, factory);

    expect(order).toEqual(['connect', 'register']);
  });

  it.each(['false', ' OFF ', '0'])(
    'leaves the in-memory adapter and warns when disabled with %p',
    async (value) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { app, config, factory } = harness(value);

      await expect(
        configureSocketAdapter(app as never, config as never, factory),
      ).resolves.toBe(false);

      expect(factory).not.toHaveBeenCalled();
      expect(app.useWebSocketAdapter).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('exactly one conversation-service instance'),
      );
    },
  );

  it('fails fast when Redis is unreachable instead of silently dropping the adapter', async () => {
    const { adapter, app, config, factory } = harness();
    adapter.connectToRedis.mockRejectedValue(new Error('redis down'));

    await expect(
      configureSocketAdapter(app as never, config as never, factory),
    ).rejects.toThrow('redis down');
    expect(app.useWebSocketAdapter).not.toHaveBeenCalled();
  });
});
