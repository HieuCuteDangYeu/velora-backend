import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisIoAdapter } from './redis-io.adapter';

export const SOCKET_IO_REDIS_ADAPTER_ENV = 'SOCKET_IO_REDIS_ADAPTER';

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled']);

/**
 * The Redis adapter stays on unless it is switched off explicitly. Any other
 * value, including a missing or unrecognised one, keeps the previous behaviour.
 */
export function isRedisAdapterEnabled(value: string | null | undefined) {
  return !DISABLED_VALUES.has((value ?? '').trim().toLowerCase());
}

type AdapterFactory = (
  app: INestApplication,
  config: ConfigService,
) => Pick<RedisIoAdapter, 'connectToRedis'> & object;

/**
 * Registers the Socket.IO Redis adapter, or leaves Nest's in-memory adapter in
 * place when SOCKET_IO_REDIS_ADAPTER is explicitly disabled. Without the
 * adapter, rooms and events are local to this process, so it is only safe while
 * a single instance of the service runs.
 */
export async function configureSocketAdapter(
  app: INestApplication,
  config: ConfigService,
  createAdapter: AdapterFactory = (nest, cfg) => new RedisIoAdapter(nest, cfg),
  serviceName = 'conversation-service',
): Promise<boolean> {
  if (!isRedisAdapterEnabled(config.get<string>(SOCKET_IO_REDIS_ADAPTER_ENV))) {
    new Logger('SocketAdapter').warn(
      `${SOCKET_IO_REDIS_ADAPTER_ENV} is disabled: Socket.IO uses its in-memory adapter. ` +
        `Run exactly one ${serviceName} instance; a second one would not receive its events.`,
    );
    return false;
  }

  const adapter = createAdapter(app, config);
  await adapter.connectToRedis();
  app.useWebSocketAdapter(adapter as never);
  return true;
}
