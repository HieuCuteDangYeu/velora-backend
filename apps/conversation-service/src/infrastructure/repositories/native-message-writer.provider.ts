import { Logger } from '@nestjs/common';
import type { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { NativeMessageWriter } from './native-message-writer';

export const MESSAGE_NATIVE_WRITER = 'MESSAGE_NATIVE_WRITER';
export const MESSAGE_WRITE_DRIVER_ENV = 'CONVERSATION_MESSAGE_WRITE_DRIVER';
export const MESSAGE_WRITE_POOL_ENV = 'CONVERSATION_MONGO_WRITE_POOL_SIZE';

/**
 * The native MongoDB writer is opt-in (CONVERSATION_MESSAGE_WRITE_DRIVER=native).
 * Without it, or if it cannot connect, messages keep going through Prisma, so
 * switching back is only an environment change.
 */
export async function createNativeMessageWriter(
  metrics: Pick<ConversationPrometheusMetricsService, 'recordMongoCommand'>,
  env: NodeJS.ProcessEnv = process.env,
  logger = new Logger('NativeMessageWriter'),
): Promise<NativeMessageWriter | null> {
  const driver = (env[MESSAGE_WRITE_DRIVER_ENV] ?? '').trim().toLowerCase();
  if (driver !== 'native') return null;

  const url = env['CONVERSATION_DATABASE_URL'];
  if (!url) {
    logger.error(
      `${MESSAGE_WRITE_DRIVER_ENV}=native needs CONVERSATION_DATABASE_URL; using Prisma`,
    );
    return null;
  }

  const poolValue = env[MESSAGE_WRITE_POOL_ENV];
  if (poolValue !== undefined && !/^[1-9]\d{0,3}$/.test(poolValue)) {
    throw new Error(`${MESSAGE_WRITE_POOL_ENV} must be a positive integer`);
  }

  const writer = new NativeMessageWriter(
    url,
    metrics,
    poolValue === undefined ? {} : { maxPoolSize: Number(poolValue) },
  );
  try {
    await writer.connect();
  } catch (error: unknown) {
    logger.error(
      `Native message writer could not connect (${(error as Error).name}); using Prisma`,
    );
    await writer.onModuleDestroy();
    return null;
  }
  logger.log('Messages are written with the native MongoDB driver');
  return writer;
}
